//! Prices a new order exactly the way validation will check it
//! (`dispatch_integrity::checks::check_pricing`): each item at its latest
//! version, any promo applied with the shared `catalog_types` pricing. The
//! client says what total it showed the customer; if prices have moved since,
//! the order is refused with the new total rather than charged silently.

use crate::order_queues::my_completions_at;
use catalog_types::{order_total, BagClaim, GoodieBag, MenuItem, PricedLine, PromoCode};
use relay_coordinator_support::original_action_of;
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::resolve_latest_fresh;

/// One thing to order, and how many.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OrderItemInput {
    pub item_ref: ActionHash,
    pub quantity: u32,
}

pub(crate) struct PricedOrder {
    pub lines: Vec<OrderLine>,
    pub order_total: u64,
    pub loyalty_proof: Vec<ActionHash>,
}

/// Prices an order at `catalog_ref`. A goodie-bag order (`bag_claim_ref`)
/// is the claimed bag at its own price; anything else is priced from the
/// menu. Fails if an item isn't on this store's menu or is sold out, if a
/// promo's requirement isn't met, or if the total isn't `expected_total`.
pub(crate) fn price_order(catalog_ref: &ActionHash, items: &[OrderItemInput], promo_ref: Option<&ActionHash>, bag_claim_ref: Option<&ActionHash>, expected_total: u64) -> ExternResult<PricedOrder> {
    let priced = match bag_claim_ref {
        Some(claim_ref) => price_bag_order(catalog_ref, claim_ref, promo_ref)?,
        None => price_menu_order(catalog_ref, items, promo_ref)?,
    };
    if priced.order_total != expected_total {
        return Err(guest(format!(
            "prices have changed since this was added to your cart: the total is now {} cents, not {expected_total}",
            priced.order_total
        )));
    }
    Ok(priced)
}

fn price_bag_order(catalog_ref: &ActionHash, claim_ref: &ActionHash, promo_ref: Option<&ActionHash>) -> ExternResult<PricedOrder> {
    if promo_ref.is_some() {
        return Err(guest("a goodie bag can't be combined with a promo code".into()));
    }
    let claim: BagClaim = decode_latest(claim_ref, "BagClaim")?;
    let bag: GoodieBag = decode_latest(&claim.bag_ref, "GoodieBag")?;
    if &bag.catalog_ref != catalog_ref {
        return Err(guest("that goodie bag isn't from this store".into()));
    }
    Ok(PricedOrder {
        lines: vec![OrderLine { item_ref: claim.bag_ref.clone(), priced_version: claim.bag_ref, quantity: 1 }],
        order_total: bag.price_cents,
        loyalty_proof: Vec::new(),
    })
}

/// An order from the menu at current prices, less `promo_ref` -- what
/// `price_order` checks a client's total against, and what a recurring
/// order is placed at (`recurring::fire`).
pub(crate) fn price_menu_order(catalog_ref: &ActionHash, items: &[OrderItemInput], promo_ref: Option<&ActionHash>) -> ExternResult<PricedOrder> {
    // One line per item, however the client listed them.
    let mut quantities: Vec<(ActionHash, u32)> = Vec::new();
    for item in items {
        match quantities.iter_mut().find(|(item_ref, _)| item_ref == &item.item_ref) {
            Some((_, quantity)) => *quantity += item.quantity,
            None => quantities.push((item.item_ref.clone(), item.quantity)),
        }
    }
    let mut lines = Vec::with_capacity(quantities.len());
    let mut priced = Vec::with_capacity(quantities.len());
    for (item_ref, quantity) in quantities {
        let record = resolve_latest_fresh(item_ref.clone())?;
        let item: MenuItem = record.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("that isn't a menu item".into()))?;
        if &item.catalog_ref != catalog_ref {
            return Err(guest(format!("{} isn't on this store's menu", item.name)));
        }
        if !item.available {
            return Err(guest(format!("{} is sold out", item.name)));
        }
        lines.push(OrderLine { item_ref: item_ref.clone(), priced_version: record.action_address().clone(), quantity });
        priced.push(PricedLine { item_ref, unit_price: item.price_cents, quantity });
    }

    let promo = match promo_ref {
        Some(promo_ref) => Some(decode_latest::<PromoCode>(promo_ref, "PromoCode")?),
        None => None,
    };
    let needed = promo.as_ref().map_or(0, |p| p.requirement.completed_orders_needed()) as usize;
    let loyalty_proof: Vec<ActionHash> = if needed > 0 { my_completions_at(catalog_ref)?.into_iter().take(needed).collect() } else { Vec::new() };
    let total = order_total(&priced, promo.as_ref().map(|p| (&p.requirement, &p.reward)), loyalty_proof.len() as u32)
        .ok_or(guest("this order doesn't meet the promo code's requirement".into()))?;
    Ok(PricedOrder { lines, order_total: total, loyalty_proof })
}

/// How long the store still honours an order priced just before one of its
/// items changed -- an honest order that raced the update. Bounded, because
/// when an order was placed is the customer's own claim (its action's
/// timestamp), which a modified client could backdate a little.
const PRICE_CHANGE_GRACE_SECS: i64 = 15 * 60;

/// The store's check before it accepts an order: every line is priced from
/// the version of its item that was current when the order was placed, and
/// that was recently. Validation proves each line is a real version of a
/// real item of this store, but it sees records as they were, so it can't
/// tell an old price from the latest -- this is where an order pinned to an
/// old price is stopped, and only the store can accept an order, so it
/// can't be skipped. It runs on the store's own conductor and reads its
/// menu's history from its own source chain, which holds every version it
/// wrote -- so, unlike a DHT read, it can't be behind. A goodie bag's line
/// is the bag itself, never outdated.
pub(crate) fn ensure_priced_from_current_menu(order_ref: &ActionHash, lines: &[OrderLine], bag_claim_ref: Option<&ActionHash>) -> ExternResult<()> {
    match outdated_item(order_ref, lines, bag_claim_ref)? {
        Some(name) => Err(guest(format!("{name} was priced from an outdated menu, so this order can't be accepted -- decline it"))),
        None => Ok(()),
    }
}

/// The name of the first item `ensure_priced_from_current_menu` would
/// refuse the order over, if any.
pub(crate) fn outdated_item(order_ref: &ActionHash, lines: &[OrderLine], bag_claim_ref: Option<&ActionHash>) -> ExternResult<Option<String>> {
    if bag_claim_ref.is_some() {
        return Ok(None);
    }
    let histories = my_item_versions(lines.iter().map(|line| line.item_ref.clone()).collect())?;
    // Read only if some line isn't at its current price.
    let mut placement = None;
    for (line, history) in lines.iter().zip(histories) {
        let versions = &history.versions;
        if versions.last().is_some_and(|current| current.action == line.priced_version) {
            continue;
        }
        let placed_at = match placement {
            Some(at) => at,
            None => *placement.insert(placement_time(order_ref)?),
        };
        // When the version the line names was replaced, if it's this item's.
        let replaced_at = versions.iter().position(|v| v.action == line.priced_version).and_then(|i| versions.get(i + 1)).map(|next| next.written_at);
        let raced = replaced_at.is_some_and(|changed| changed > placed_at);
        let recent = sys_time()?.as_seconds_and_nanos().0 - placed_at.as_seconds_and_nanos().0 <= PRICE_CHANGE_GRACE_SECS;
        if !(raced && recent) {
            let name = if history.name.is_empty() { "An item".to_string() } else { history.name };
            return Ok(Some(name));
        }
    }
    Ok(None)
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
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "catalog", "get_my_item_versions".into(), None, item_refs)? else {
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
