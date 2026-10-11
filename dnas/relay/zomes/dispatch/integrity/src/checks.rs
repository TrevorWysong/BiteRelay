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
use catalog_types::{order_total, BagClaimStatus, GoodieBag, MenuItem, PricedLine};
use relay_integrity_support::limits::{MAX_LINE_QUANTITY, MAX_ORDER_LINES};
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
    /// The store's minimum order, as it stood when the order was placed.
    pub min_subtotal: Option<u64>,
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
/// versions they name, less any promo discount -- computed with the same
/// pricing the coordinator uses (`catalog_types::pricing`), so no client
/// can pay a store a different amount than its menu says.
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
    let distinct: BTreeSet<_> = order.lines.iter().map(|line| &line.item_ref).collect();
    if distinct.len() != order.lines.len() {
        return Ok(Some("each item may only appear on one line".into()));
    }

    if let Some(claim_ref) = order.bag_claim_ref {
        return check_bag_order_price(&order, claim_ref);
    }

    let mut priced = Vec::with_capacity(order.lines.len());
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
        priced.push(PricedLine { item_ref: line.item_ref.clone(), unit_price: item.price_cents, quantity: line.quantity });
    }
    if let Some(min) = order.min_subtotal {
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
    let Some(expected) = order_total(&priced, promo.as_ref().map(|p| (&p.requirement, &p.reward)), completed) else {
        return Ok(Some("the promo code's requirement isn't met by this order".into()));
    };
    if order.order_total != expected {
        return Ok(Some(format!("order_total must be {expected}: the lines at their priced versions, less any promo discount")));
    }
    Ok(None)
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
    let expected_line = OrderLine { item_ref: claim.bag_ref.clone(), priced_version: claim.bag_ref.clone(), quantity: 1 };
    if order.lines != [expected_line] {
        return Ok(Some("a goodie-bag order is exactly one of the claimed bag".into()));
    }
    let Some(bag) = decode::<GoodieBag>(&must_get_valid_record(claim.bag_ref)?) else {
        return Ok(Some("the claimed bag is not a GoodieBag".into()));
    };
    if &bag.catalog_ref != order.catalog_ref || order.order_total != bag.price_cents {
        return Ok(Some("a goodie-bag order costs the bag's price, at the bag's own store".into()));
    }
    Ok(None)
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
