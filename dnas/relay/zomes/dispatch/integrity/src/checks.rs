//! Checks both order verticals run on a new order: its price, and its
//! optional references -- a promo code and a redeemed goodie-bag claim.
//!
//! Both referenced entries can be updated after creation (`PromoCode.active`,
//! `BagClaim.status`), and `must_get_valid_record` only ever returns a
//! record as created -- validation can't ask what another entry's *current*
//! state is. So what's enforced here is everything fixed at creation;
//! "is this code still active" and "is this claim confirmed yet" are
//! coordinator pre-checks (`request_delivery`/`request_pickup_order`).

use super::*;
use catalog_types::{order_tax, order_total, total_with_tax, BagClaimStatus, GoodieBag, MenuItem, PricedLine, TaxableLine};
use dispatch_types::LinePricer;
use relay_integrity_support::limits::{MAX_LINE_QUANTITY, MAX_ORDER_CHOICES, MAX_ORDER_LINES};
use relay_integrity_support::{decode, original_creation};
use std::collections::BTreeSet;

/// The parts of a new order its price depends on, from either order type.
pub(crate) struct OrderPricing<'a> {
    pub requester: &'a AgentPubKey,
    pub catalog_ref: &'a ActionHash,
    pub lines: &'a [OrderLine],
    pub order_total: u64,
    pub promo_code_ref: Option<&'a ActionHash>,
    pub bag_claim_ref: Option<&'a ActionHash>,
    pub loyalty_proof: &'a [ActionHash],
    pub placed_at: Timestamp,
    /// The store as it stood when the order was placed (the version it
    /// cites): its minimum order and its tax rates.
    pub store: &'a MerchantCatalog,
    pub tax_cents: u64,
    /// Whether it's a delivery (a pickup otherwise).
    pub delivery: bool,
    /// The customer's confirmation of their age (a pickup's `age_confirmed`).
    pub age_confirmed: bool,
}

/// The store version an order cites (`catalog_version`) -- the terms it
/// was placed under -- or why it can't be: it must be a version of the
/// order's own store.
pub(crate) fn store_version(catalog_ref: &ActionHash, catalog_version: &ActionHash) -> ExternResult<Result<MerchantCatalog, String>> {
    if &original_creation(catalog_version.clone())? != catalog_ref {
        return Ok(Err("catalog_version must be a version of the order's own store".into()));
    }
    Ok(decode::<MerchantCatalog>(&must_get_valid_record(catalog_version.clone())?).ok_or_else(|| "catalog_version must be a store".into()))
}

/// `order_total` must be exactly what the order's lines cost at the item
/// versions they name, less any promo discount, plus the store's tax when
/// it adds it -- and `tax_cents` exactly that tax, at the rates of the
/// store version the order cites -- computed with the same pricing the
/// coordinator uses (`catalog_types::pricing`), so no client can pay a
/// store a different amount than its menu says, nor misstate its tax.
///
/// What this can't know is whether a named version is the item's *latest*
/// one: validation only sees records as they were. The honest coordinator
/// always prices at the latest version, and the store sees which version
/// each line was priced at before confirming the order.
pub(crate) fn check_pricing(order: OrderPricing<'_>) -> ExternResult<Option<String>> {
    if order.lines.is_empty() || order.lines.len() > MAX_ORDER_LINES {
        return Ok(Some(format!("an order has between 1 and {MAX_ORDER_LINES} lines")));
    }
    if order.lines.iter().any(|line| line.quantity == 0 || line.quantity > MAX_LINE_QUANTITY) {
        return Ok(Some(format!("every line has between one and {MAX_LINE_QUANTITY} units")));
    }
    // The same item with the same choices is one line, with its quantity.
    let choices: usize = order.lines.iter().map(|line| catalog_types::choice_count(&line.selections)).sum();
    if choices > MAX_ORDER_CHOICES {
        return Ok(Some(format!("an order chooses at most {MAX_ORDER_CHOICES} options across its lines")));
    }
    let repeated = order.lines.iter().enumerate().any(|(i, line)| order.lines[..i].iter().any(|l| l.item_ref == line.item_ref && l.selections == line.selections));
    if repeated {
        return Ok(Some("the same item with the same choices is one line".into()));
    }

    if let Some(claim_ref) = order.bag_claim_ref {
        return check_bag_order_price(&order, claim_ref);
    }

    let mut priced = Vec::with_capacity(order.lines.len());
    let mut categories = Vec::with_capacity(order.lines.len());
    let mut age_restricted = false;
    let mut pricer = LinePricer::default();
    for line in order.lines {
        if original_creation(line.priced_version.clone())? != line.item_ref {
            return Ok(Some("a line's priced version must be a version of its own item".into()));
        }
        let Some(item) = decode::<MenuItem>(&must_get_valid_record(line.priced_version.clone())?) else {
            return Ok(Some("a line must be priced from a MenuItem".into()));
        };
        if &item.catalog_ref != order.catalog_ref {
            return Ok(Some("every item must be on this store's menu".into()));
        }
        let unit_price = match pricer.unit_price(&item, &line.selections)? {
            Ok(price) => price,
            Err(reason) => return Ok(Some(reason)),
        };
        priced.push(PricedLine { item_ref: line.item_ref.clone(), base_price: item.price_cents, unit_price, quantity: line.quantity });
        categories.push(item.tax_category);
        age_restricted |= item.age_restricted;
    }
    if age_restricted {
        if let Some(problem) = age_restriction_problem(&order) {
            return Ok(Some(problem));
        }
    }
    if let Some(min) = order.store.min_order_cents {
        let subtotal: u64 = priced.iter().map(|line| line.unit_price * u64::from(line.quantity)).sum();
        if subtotal < min {
            return Ok(Some("the order is below the store's minimum".into()));
        }
    }

    let promo = match order.promo_code_ref {
        Some(promo_ref) => {
            if let Some(reason) = check_promo_code(promo_ref, order.catalog_ref, order.placed_at)? {
                return Ok(Some(reason));
            }
            decode::<PromoCode>(&must_get_valid_record(promo_ref.clone())?)
        }
        None => None,
    };
    let needed = promo.as_ref().map_or(0, |p| p.requirement.completed_orders_needed());
    if order.loyalty_proof.len() != needed as usize {
        return Ok(Some(format!("loyalty_proof must list exactly the {needed} completed orders the promo needs")));
    }
    let completed = match count_completed_orders(order.requester, order.catalog_ref, order.loyalty_proof)? {
        Ok(count) => count,
        Err(reason) => return Ok(Some(reason)),
    };
    let Some(food) = order_total(&priced, promo.as_ref().map(|p| (&p.requirement, &p.reward)), completed) else {
        return Ok(Some("the promo code's requirement isn't met by this order".into()));
    };
    let taxable: Vec<TaxableLine> = priced.iter().zip(&categories).map(|(line, category)| TaxableLine { category, total: line.total() }).collect();
    Ok(check_taxed_total(&order, food, &taxable, "the lines at their priced versions, less any promo discount"))
}

/// Why an order with age-restricted items (alcohol, tobacco) can't be
/// placed, if it can't: the network must sell them at all; they're
/// collected in person, where the store checks ID -- never delivered; and
/// the customer confirms their age.
fn age_restriction_problem(order: &OrderPricing<'_>) -> Option<String> {
    let Some(age) = relay_governance::restricted_min_age() else {
        return Some("this network doesn't sell age-restricted items".into());
    };
    if order.delivery {
        return Some("age-restricted items are collected in person, where the store checks ID".into());
    }
    (!order.age_confirmed).then(|| format!("an order with age-restricted items needs the customer to confirm they're {age} or older"))
}

/// Whether the order's tax and total are what its food comes to under the
/// store's tax -- or what's wrong.
fn check_taxed_total(order: &OrderPricing<'_>, food: u64, lines: &[TaxableLine], what: &str) -> Option<String> {
    let store = order.store;
    let tax = order_tax(lines, food, &store.tax_rates, store.prices_include_tax);
    if order.tax_cents != tax {
        return Some(format!("tax_cents must be {tax}: the store's tax on this order"));
    }
    let expected = total_with_tax(food, tax, store.prices_include_tax);
    (order.order_total != expected).then(|| format!("order_total must be {expected}: {what}, with the store's tax"))
}

/// A goodie-bag order is the bag itself, once, at the bag's price -- its
/// terms can't change after listing, so the bag as created is the price.
fn check_bag_order_price(order: &OrderPricing<'_>, claim_ref: &ActionHash) -> ExternResult<Option<String>> {
    if order.promo_code_ref.is_some() {
        return Ok(Some("a goodie-bag order can't also use a promo code".into()));
    }
    let Some(claim) = decode::<BagClaim>(&must_get_valid_record(claim_ref.clone())?) else {
        return Ok(Some("bag_claim_ref does not point at a BagClaim entry".into()));
    };
    let expected_line = OrderLine { item_ref: claim.bag_ref.clone(), priced_version: claim.bag_ref.clone(), quantity: 1, selections: Vec::new() };
    if order.lines != [expected_line] {
        return Ok(Some("a goodie-bag order is exactly one of the claimed bag".into()));
    }
    let Some(bag) = decode::<GoodieBag>(&must_get_valid_record(claim.bag_ref)?) else {
        return Ok(Some("the claimed bag is not a GoodieBag".into()));
    };
    if &bag.catalog_ref != order.catalog_ref {
        return Ok(Some("a goodie-bag order is from the bag's own store".into()));
    }
    // A bag is food at the store's default rate.
    Ok(check_taxed_total(order, bag.price_cents, &[TaxableLine { category: "", total: bag.price_cents }], "the bag's price"))
}

/// How many distinct earlier orders at this store `proof` shows the
/// requester completed. Each entry must be the requester's own completion
/// (`Delivered`/`PickedUp`) of an order at this store -- the customer
/// authors both, so each is on their own chain.
fn count_completed_orders(requester: &AgentPubKey, catalog_ref: &ActionHash, proof: &[ActionHash]) -> ExternResult<Result<u32, String>> {
    let mut orders = BTreeSet::new();
    for completion in proof {
        // A version completing one of the customer's own orders at this
        // store -- whoever wrote it: a delivery's driver completes it on the
        // customer's own proof.
        let record = must_get_valid_record(completion.clone())?;
        if !matches!(record.action().data, ActionData::Update(_)) {
            return Ok(Err("loyalty_proof must be order completions".into()));
        }
        let completed_here = if let Some(order) = decode::<DeliveryOrder>(&record) {
            &order.requester == requester && matches!(order.status, DeliveryStatus::Delivered | DeliveryStatus::Collected) && &order.catalog_ref == catalog_ref
        } else if let Some(order) = decode::<PickupOrder>(&record) {
            &order.requester == requester && order.status == PickupStatus::PickedUp && &order.catalog_ref == catalog_ref
        } else {
            false
        };
        if !completed_here {
            return Ok(Err("each loyalty_proof entry must complete an order at this store".into()));
        }
        if !orders.insert(original_creation(completion.clone())?) {
            return Ok(Err("loyalty_proof lists the same order twice".into()));
        }
    }
    Ok(Ok(orders.len() as u32))
}

/// The promo must belong to this order's store and not have expired when
/// the order was placed. (The discount's effect on `order_total` isn't
/// re-derived here: that would need the full cart, which an order doesn't
/// carry.)
pub(crate) fn check_promo_code(promo_ref: &ActionHash, catalog_ref: &ActionHash, placed_at: Timestamp) -> ExternResult<Option<String>> {
    let Some(promo) = decode::<PromoCode>(&must_get_valid_record(promo_ref.clone())?) else {
        return Ok(Some("promo_code_ref does not point at a PromoCode entry".into()));
    };
    if &promo.catalog_ref != catalog_ref {
        return Ok(Some("promo_code_ref does not belong to this order's store".into()));
    }
    if promo.expires_at.is_some_and(|expires| placed_at >= expires) {
        return Ok(Some("promo code has expired".into()));
    }
    Ok(None)
}

/// How a redeemed claim must have been claimed, for the order redeeming it.
pub(crate) enum ClaimedFor {
    Pickup,
    Delivery,
}

/// The order must cite the store's confirmation of the claim (validation
/// reads the record it cites literally, so citing the claim as first made
/// would prove nothing); the claim must be this customer's own, claimed for
/// this kind of order, and not already redeemed by an earlier order.
///
/// Single use is checkable deterministically because both the claim and
/// every order redeeming it live on the customer's own source chain: walk
/// back from just before this order to the claim (usually a handful of
/// actions, since finalization follows confirmation), and reject if any
/// order in between already redeems the same claim -- compared by the
/// claim's identity, so citing a different version of it doesn't count as
/// a different claim. Skipping that walk would need a forked chain, which
/// Holochain detects and warrants.
pub(crate) fn check_bag_claim(claim_ref: &ActionHash, requester: &AgentPubKey, claimed_for: ClaimedFor, prev_action: Option<&ActionHash>) -> ExternResult<Option<String>> {
    let Some(claim) = decode::<BagClaim>(&must_get_valid_record(claim_ref.clone())?) else {
        return Ok(Some("bag_claim_ref does not point at a BagClaim entry".into()));
    };
    if claim.status != BagClaimStatus::Confirmed {
        return Ok(Some("bag_claim_ref must be the store's confirmation of the claim".into()));
    }
    if &claim.customer != requester {
        return Ok(Some("bag_claim_ref's own customer must match this order's requester".into()));
    }
    let fulfillment_matches = match claimed_for {
        ClaimedFor::Pickup => claim.fulfillment == BagClaimFulfillment::Pickup,
        ClaimedFor::Delivery => matches!(claim.fulfillment, BagClaimFulfillment::Delivery { .. }),
    };
    if !fulfillment_matches {
        return Ok(Some("bag_claim_ref was not claimed for this kind of order".into()));
    }
    let Some(prev_action) = prev_action else {
        return Ok(Some("an order redeeming a claim can't be the first action on a chain".into()));
    };
    let claim_origin = original_creation(claim_ref.clone())?;
    if already_redeemed(requester, prev_action, &claim_origin)? {
        return Ok(Some("this goodie bag claim has already been redeemed".into()));
    }
    Ok(None)
}

/// Whether any order between the claim (`claim_origin`, its creation on
/// the customer's chain) and `chain_top` (inclusive) on `requester`'s chain
/// already redeems it, citing any version of it.
fn already_redeemed(requester: &AgentPubKey, chain_top: &ActionHash, claim_origin: &ActionHash) -> ExternResult<bool> {
    let orders = entries_created(requester, ChainFilter::until_hash(chain_top.clone(), claim_origin.clone()), &order_types()?)?;
    for bytes in orders {
        let cited = DeliveryOrder::try_from(bytes.clone())
            .ok()
            .and_then(|o| o.bag_claim_ref)
            .or_else(|| PickupOrder::try_from(bytes).ok().and_then(|o| o.bag_claim_ref));
        if let Some(cited) = cited {
            if &original_creation(cited)? == claim_origin {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Why a customer can't place another order now, if they can't: they've
/// placed as many as the network allows within one store response window
/// (`relay_governance::max_pending_orders`), counting back from this one's
/// time `at` -- which can't be earlier than the chain before it.
pub(crate) fn check_order_rate(requester: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<Option<String>> {
    let Some(prev_action) = prev_action else { return Ok(None) };
    let window = relay_governance::store_response_window().as_micros() as i64;
    let since = Timestamp::from_micros(at.as_micros() - window);
    let placed = entries_since(requester, prev_action, since, &order_types()?)?.len();
    Ok((placed >= relay_governance::max_pending_orders() as usize).then(|| "you've placed as many orders as the network allows at once; wait for a store to answer".into()))
}
