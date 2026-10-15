//! Prices a new order exactly the way validation will check it
//! (`dispatch_integrity::checks::check_pricing`): each item at its latest
//! version, any promo applied with the shared `catalog_types` pricing. The
//! client says what total it showed the customer; if prices have moved since,
//! the order is refused with the new total rather than charged silently.

use crate::order_queues::my_completions_at;
use catalog_types::{order_tax, order_total, total_with_tax, BagClaim, GoodieBag, MerchantCatalog, MenuItem, PricedLine, PromoCode, TaxableLine};
use relay_coordinator_support::{decode_or, original_action_of};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::resolve_latest_fresh;

pub use dispatch_integrity::OrderItem;

pub(crate) struct PricedOrder {
    pub lines: Vec<OrderLine>,
    /// With the store's tax, when it adds it.
    pub order_total: u64,
    /// The tax in it.
    pub tax_cents: u64,
    pub loyalty_proof: Vec<ActionHash>,
    /// The menu items' price before any promo -- what a store's minimum
    /// order is measured against. `None` for a goodie bag, priced on its own.
    pub menu_subtotal: Option<u64>,
}

/// Refuses an order below its store's minimum (`min_order_cents`) --
/// validation's rule (`dispatch_integrity::checks`), told first.
pub(crate) fn ensure_store_minimum(store: &catalog_types::MerchantCatalog, priced: &PricedOrder) -> ExternResult<()> {
    match (store.min_order_cents, priced.menu_subtotal) {
        (Some(min), Some(subtotal)) if subtotal < min => Err(guest("This order is below the store's minimum. Add a little more to place it.".into())),
        _ => Ok(()),
    }
}

/// The order's tax under `store`'s rates, and what it comes to with it.
fn taxed(store: &MerchantCatalog, food: u64, lines: &[TaxableLine]) -> (u64, u64) {
    let tax = order_tax(lines, food, &store.tax_rates, store.prices_include_tax);
    (total_with_tax(food, tax, store.prices_include_tax), tax)
}

/// Prices an order at `catalog_ref`, under `store` -- the version of it the
/// order will cite, whose tax it carries. A goodie-bag order
/// (`bag_claim_ref`) is the claimed bag at its own price; anything else is
/// priced from the menu. Fails if an item isn't on this store's menu or is
/// sold out, if a promo's requirement isn't met, or if the total isn't
/// `expected_total`.
pub(crate) fn price_order(catalog_ref: &ActionHash, store: &MerchantCatalog, items: &[OrderItem], promo_ref: Option<&ActionHash>, bag_claim_ref: Option<&ActionHash>, expected_total: u64) -> ExternResult<PricedOrder> {
    let priced = match bag_claim_ref {
        Some(claim_ref) => price_bag_order(catalog_ref, store, claim_ref, promo_ref)?,
        None => price_menu_order(catalog_ref, store, items, promo_ref)?,
    };
    if priced.order_total != expected_total {
        return Err(guest(format!(
            "prices have changed since this was added to your cart: the total is now {} cents, not {expected_total}",
            priced.order_total
        )));
    }
    Ok(priced)
}

fn price_bag_order(catalog_ref: &ActionHash, store: &MerchantCatalog, claim_ref: &ActionHash, promo_ref: Option<&ActionHash>) -> ExternResult<PricedOrder> {
    if promo_ref.is_some() {
        return Err(guest("a goodie bag can't be combined with a promo code".into()));
    }
    let claim: BagClaim = decode_latest(claim_ref, "BagClaim")?;
    let bag: GoodieBag = decode_latest(&claim.bag_ref, "GoodieBag")?;
    if &bag.catalog_ref != catalog_ref {
        return Err(guest("that goodie bag isn't from this store".into()));
    }
    // A bag is food at the store's default rate.
    let (order_total, tax_cents) = taxed(store, bag.price_cents, &[TaxableLine { category: "", total: bag.price_cents }]);
    Ok(PricedOrder {
        lines: vec![OrderLine { item_ref: claim.bag_ref.clone(), priced_version: claim.bag_ref, quantity: 1, selections: Vec::new() }],
        order_total,
        tax_cents,
        loyalty_proof: Vec::new(),
        menu_subtotal: None,
    })
}

/// An order from the menu at current prices, less `promo_ref` -- what
/// `price_order` checks a client's total against, and what a recurring
/// order is placed at (`recurring::fire`).
pub(crate) fn price_menu_order(catalog_ref: &ActionHash, store: &MerchantCatalog, items: &[OrderItem], promo_ref: Option<&ActionHash>) -> ExternResult<PricedOrder> {
    // One line per item and its choices, however the client listed them.
    let mut merged: Vec<OrderItem> = Vec::new();
    for item in items {
        if let Some(problem) = catalog_types::choices_problem(&item.selections) {
            return Err(guest(problem));
        }
        match merged.iter_mut().find(|m| m.item_ref == item.item_ref && m.selections == item.selections) {
            Some(line) => line.quantity = line.quantity.saturating_add(item.quantity),
            None => merged.push(item.clone()),
        }
    }
    let choices: usize = merged.iter().map(|item| count_inputs(&item.selections)).sum();
    if choices > relay_integrity_support::limits::MAX_ORDER_CHOICES {
        return Err(guest(format!("An order can have at most {} choices across its items.", relay_integrity_support::limits::MAX_ORDER_CHOICES)));
    }
    let mut lines = Vec::with_capacity(merged.len());
    let mut priced = Vec::with_capacity(merged.len());
    let mut categories = Vec::with_capacity(merged.len());
    let mut pricer = LinePricer::default();
    for OrderItem { item_ref, quantity, selections } in merged {
        let record = resolve_latest_fresh(item_ref.clone())?;
        let item: MenuItem = record.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("that isn't a menu item".into()))?;
        if &item.catalog_ref != catalog_ref {
            return Err(guest(format!("{} isn't on this store's menu", item.name)));
        }
        if !item.available {
            return Err(guest(format!("{} is sold out", item.name)));
        }
        let selections = at_latest(&selections)?;
        let unit_price = pricer.unit_price(&item, &selections)?.map_err(|reason| guest(format!("{}: {reason}", item.name)))?;
        lines.push(OrderLine { item_ref: item_ref.clone(), priced_version: record.action_address().clone(), quantity, selections });
        priced.push(PricedLine { item_ref, base_price: item.price_cents, unit_price, quantity });
        categories.push(item.tax_category);
    }

    let promo = match promo_ref {
        Some(promo_ref) => Some(decode_latest::<PromoCode>(promo_ref, "PromoCode")?),
        None => None,
    };
    let needed = promo.as_ref().map_or(0, |p| p.requirement.completed_orders_needed()) as usize;
    let loyalty_proof: Vec<ActionHash> = if needed > 0 { my_completions_at(catalog_ref)?.into_iter().take(needed).collect() } else { Vec::new() };
    let food = order_total(&priced, promo.as_ref().map(|p| (&p.requirement, &p.reward)), loyalty_proof.len() as u32)
        .ok_or(guest("this order doesn't meet the promo code's requirement".into()))?;
    let taxable: Vec<TaxableLine> = priced.iter().zip(&categories).map(|(line, category)| TaxableLine { category, total: line.total() }).collect();
    let (order_total, tax_cents) = taxed(store, food, &taxable);
    let menu_subtotal = priced.iter().map(|line| line.unit_price * u64::from(line.quantity)).sum();
    Ok(PricedOrder { lines, order_total, tax_cents, loyalty_proof, menu_subtotal: Some(menu_subtotal) })
}

/// How many options `selections` choose, nested ones included.
fn count_inputs(selections: &[SelectionInput]) -> usize {
    selections.iter().flat_map(|s| &s.options).map(|c| 1 + count_inputs(&c.nested)).sum()
}

/// Choices at each group's latest version -- what the customer sees now.
fn at_latest(selections: &[SelectionInput]) -> ExternResult<Vec<Selection>> {
    selections
        .iter()
        .map(|s| {
            let options = s.options.iter().map(|c| Ok(Chosen { option: c.option, quantity: c.quantity, nested: at_latest(&c.nested)? })).collect::<ExternResult<_>>()?;
            Ok(Selection { group: s.group.clone(), version: resolve_latest_fresh(s.group.clone())?.action_address().clone(), options })
        })
        .collect()
}

/// Every (group, version) a line's choices were priced at, nested ones
/// included.
fn priced_groups(selections: &[Selection], out: &mut Vec<(ActionHash, ActionHash)>) {
    for s in selections {
        out.push((s.group.clone(), s.version.clone()));
        for c in &s.options {
            priced_groups(&c.nested, out);
        }
    }
}

/// How long the store still honours an order priced just before one of its
/// items changed -- an honest order that raced the update
/// (`relay_governance::price_change_grace`). Bounded, because when an order
/// was placed is the customer's own claim (its action's timestamp), which a
/// modified client could backdate a little.
fn price_change_grace_secs() -> i64 {
    relay_governance::price_change_grace().as_secs() as i64
}

/// The store's check before it accepts an order: every line is priced from
/// the version of its item that was current when the order was placed, and
/// that was recently. Validation proves each line is a real version of a
/// real item of this store, but it sees records as they were, so it can't
/// tell an old price from the latest -- this is where an order pinned to an
/// old price is stopped, and only the store can accept an order, so it
/// can't be skipped. It runs on the store's own conductor and reads its
/// menu's history from its own source chain, which holds every version it
/// wrote -- so, unlike a DHT read, it can't be behind. A goodie bag's line
/// is the bag itself, never outdated. The same goes for the promo: it must
/// still be live (validation can't tell a deactivated code from a live one
/// either), or have stopped only after this order was placed, recently.
pub(crate) fn ensure_priced_from_current_menu(order_ref: &ActionHash, lines: &[OrderLine], bag_claim_ref: Option<&ActionHash>, promo_ref: Option<&ActionHash>) -> ExternResult<()> {
    // An order dated in the future would hold back the store's decisions
    // until then: none can be dated before the order.
    let placed = get(order_ref.clone(), GetOptions::default())?.ok_or(guest("order not found".into()))?.action().timestamp();
    if placed.as_micros() > sys_time()?.as_micros() + relay_governance::clock_tolerance().as_micros() as i64 {
        return Err(guest("this order is dated in the future, so it can't be accepted -- decline it".into()));
    }
    match outdated_item(order_ref, lines, bag_claim_ref, promo_ref)? {
        Some(name) => Err(guest(format!("{name} was priced from an outdated menu, so this order can't be accepted -- decline it"))),
        None => Ok(()),
    }
}

/// The name of the first item `ensure_priced_from_current_menu` would
/// refuse the order over, if any.
pub(crate) fn outdated_item(order_ref: &ActionHash, lines: &[OrderLine], bag_claim_ref: Option<&ActionHash>, promo_ref: Option<&ActionHash>) -> ExternResult<Option<String>> {
    if bag_claim_ref.is_some() {
        return Ok(None);
    }
    if let Some(promo_ref) = promo_ref {
        if promo_lapsed(order_ref, promo_ref)? {
            return Ok(Some("The promo code".into()));
        }
    }
    // Each item at the version its line was priced at, and each choice
    // group at its own.
    let mut cited: Vec<(ActionHash, ActionHash)> = lines.iter().map(|line| (line.item_ref.clone(), line.priced_version.clone())).collect();
    let item_count = cited.len();
    for line in lines {
        priced_groups(&line.selections, &mut cited);
    }
    let mut histories = my_item_versions(cited[..item_count].iter().map(|(item, _)| item.clone()).collect())?;
    if cited.len() > item_count {
        histories.extend(my_versions("get_my_group_versions", cited[item_count..].iter().map(|(group, _)| group.clone()).collect())?);
    }
    // Read only if something isn't at its current price.
    let mut placement = None;
    for ((_, version), history) in cited.iter().zip(histories) {
        if history.versions.last().is_some_and(|current| &current.action == version) {
            continue;
        }
        let placed_at = match placement {
            Some(at) => at,
            None => *placement.insert(placement_time(order_ref)?),
        };
        if !honoured(&history.versions, version, placed_at)? {
            let name = if history.name.is_empty() { "An item".to_string() } else { history.name };
            return Ok(Some(name));
        }
    }
    Ok(None)
}

/// Whether an order placed at `placed_at`, citing version `cited` of
/// something with `versions` (oldest first), is still honoured: it's the
/// current version, or the order raced its replacement, recently (within
/// `price_change_grace`).
fn honoured(versions: &[ItemVersionWire], cited: &ActionHash, placed_at: Timestamp) -> ExternResult<bool> {
    if versions.last().is_some_and(|current| &current.action == cited) {
        return Ok(true);
    }
    // When the cited version was replaced, if it's one of these.
    let replaced_at = versions.iter().position(|v| &v.action == cited).and_then(|i| versions.get(i + 1)).map(|next| next.written_at);
    let raced = replaced_at.is_some_and(|changed| changed > placed_at);
    let recent = sys_time()?.as_seconds_and_nanos().0 - placed_at.as_seconds_and_nanos().0 <= price_change_grace_secs();
    Ok(raced && recent)
}

/// Whether the store terms an order cites (`catalog_version`) give it more
/// than the store's current terms do -- a lower minimum, a wider delivery
/// area, a larger share of the fee -- and the order didn't just race the
/// change. Validation can check only that it's a version of the store, not
/// that it's current; so, as with prices, the store checks it against its
/// own chain before accepting. Terms no more generous than today's are
/// honoured whatever version they're from: a store's version changes for
/// many reasons (its hours, being busy) that change nothing an order holds
/// it to, and a customer's view of it can lag a little.
pub(crate) fn terms_outdated(order_ref: &ActionHash, catalog_ref: &ActionHash, catalog_version: &ActionHash) -> ExternResult<bool> {
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "catalog", "get_my_store_versions".into(), None, catalog_ref.clone())? else {
        return Err(guest("reading your store's history failed".into()));
    };
    let versions: Vec<ItemVersionWire> = io.decode().map_err(|e| wasm_error!(e))?;
    let (Some(cited), Some(current)) = (store_at(catalog_version)?, versions.last().map(|v| store_at(&v.action)).transpose()?.flatten()) else {
        // Not one of this store's versions at all.
        return Ok(true);
    };
    if !cited.offers_more_than(&current) {
        return Ok(false);
    }
    Ok(!honoured(&versions, catalog_version, placement_time(order_ref)?)?)
}

/// The store as of one of its versions.
fn store_at(version: &ActionHash) -> ExternResult<Option<catalog_types::MerchantCatalog>> {
    Ok(get(version.clone(), GetOptions::local())?.and_then(|record| decode_or(&record)))
}

/// Refuses an order placed under store terms that had already changed --
/// see `terms_outdated`.
pub(crate) fn ensure_current_terms(order_ref: &ActionHash, catalog_ref: &ActionHash, catalog_version: &ActionHash) -> ExternResult<()> {
    if terms_outdated(order_ref, catalog_ref, catalog_version)? {
        return Err(guest("This order was placed under your store's earlier terms (its minimum, delivery area or fee share), so it can't be accepted -- decline it.".into()));
    }
    Ok(())
}

/// Mirrors `catalog::PromoVersion` over the zome-call boundary.
#[derive(Deserialize, Debug)]
struct PromoVersionWire {
    active: bool,
    expires_at: Option<Timestamp>,
    written_at: Timestamp,
}

/// Whether the order's promo can't be honoured: no longer live, and it
/// stopped before the order was placed or long enough ago that the order
/// didn't just race it. Read from the store's own chain.
fn promo_lapsed(order_ref: &ActionHash, promo_ref: &ActionHash) -> ExternResult<bool> {
    let promo = original_action_of(promo_ref.clone())?;
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "catalog", "get_my_promo_versions".into(), None, promo)? else {
        return Err(guest("reading your promo codes failed".into()));
    };
    let versions: Vec<PromoVersionWire> = io.decode().map_err(|e| wasm_error!(e))?;
    // Not one of this store's codes at all.
    let Some(current) = versions.last() else { return Ok(true) };
    let now = sys_time()?;
    let expired = |at: Timestamp| current.expires_at.is_some_and(|expires| at >= expires);
    if current.active && !expired(now) {
        return Ok(false);
    }
    // When it stopped: the start of its latest run of inactive versions, or
    // its expiry, whichever came first.
    let deactivated = versions.iter().rev().take_while(|v| !v.active).last().map(|v| v.written_at);
    let stopped = [deactivated, current.expires_at].into_iter().flatten().min().unwrap_or(now);
    let placed_at = placement_time(order_ref)?;
    let recent = now.as_seconds_and_nanos().0 - placed_at.as_seconds_and_nanos().0 <= price_change_grace_secs();
    Ok(!(placed_at < stopped && recent))
}

/// Mirrors `catalog::ItemVersions`/`ItemVersion` over the zome-call boundary.
#[derive(Deserialize, Debug)]
struct ItemVersionsWire {
    name: String,
    versions: Vec<ItemVersionWire>,
}

#[derive(Deserialize, Debug)]
struct ItemVersionWire {
    action: ActionHash,
    written_at: Timestamp,
}

/// Each item's history from the caller's (the store's) own chain, in order.
fn my_item_versions(item_refs: Vec<ActionHash>) -> ExternResult<Vec<ItemVersionsWire>> {
    my_versions("get_my_item_versions", item_refs)
}

/// Each item's or choice group's history from the store's own chain.
fn my_versions(function: &str, refs: Vec<ActionHash>) -> ExternResult<Vec<ItemVersionsWire>> {
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "catalog", function.into(), None, refs)? else {
        return Err(guest("reading your menu's history failed".into()));
    };
    io.decode().map_err(|e| wasm_error!(e))
}

/// When the order was placed: its creation action's own timestamp.
fn placement_time(order_ref: &ActionHash) -> ExternResult<Timestamp> {
    let original = original_action_of(order_ref.clone())?;
    let record = match get(original.clone(), GetOptions::local())? {
        Some(record) => record,
        None => get(original, GetOptions::network())?.ok_or(guest("order not found".into()))?,
    };
    Ok(record.action().timestamp())
}

/// An entry at its current state, from the network.
fn decode_latest<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(action_hash: &ActionHash, type_name: &str) -> ExternResult<T> {
    resolve_latest_fresh(action_hash.clone())?
        .entry()
        .to_app_option::<T>()
        .map_err(|e| wasm_error!(e))?
        .ok_or(guest(format!("that isn't a {type_name}")))
}

fn guest(message: String) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message))
}
