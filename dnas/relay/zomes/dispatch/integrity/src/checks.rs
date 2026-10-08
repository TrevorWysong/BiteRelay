//! Checks both order verticals run on a new order's optional references: a
//! promo code and a redeemed goodie-bag claim.
//!
//! Both referenced entries can be updated after creation (`PromoCode.active`,
//! `BagClaim.status`), and `must_get_valid_record` only ever returns a
//! record as created -- validation can't ask what another entry's *current*
//! state is. So what's enforced here is everything fixed at creation;
//! "is this code still active" and "is this claim confirmed yet" are
//! coordinator pre-checks (`request_delivery`/`request_pickup_order`).

use super::*;
use relay_integrity_support::decode;

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

/// The claim must be this customer's own, claimed for this kind of order,
/// and not already redeemed by an earlier order.
///
/// Single use is checkable deterministically because both the claim and
/// every order redeeming it live on the customer's own source chain: walk
/// back from just before this order to the claim (usually a handful of
/// actions, since finalization follows confirmation), and reject if any
/// order in between already names the same claim. Skipping that walk would
/// need a forked chain, which Holochain detects and warrants.
pub(crate) fn check_bag_claim(claim_ref: &ActionHash, requester: &AgentPubKey, claimed_for: ClaimedFor, prev_action: Option<&ActionHash>) -> ExternResult<Option<String>> {
    let Some(claim) = decode::<BagClaim>(&must_get_valid_record(claim_ref.clone())?) else {
        return Ok(Some("bag_claim_ref does not point at a BagClaim entry".into()));
    };
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
    if already_redeemed(requester, prev_action, claim_ref)? {
        return Ok(Some("this goodie bag claim has already been redeemed".into()));
    }
    Ok(None)
}

/// Whether any order between `claim_ref` and `chain_top` (inclusive) on
/// `requester`'s chain already redeems `claim_ref`.
fn already_redeemed(requester: &AgentPubKey, chain_top: &ActionHash, claim_ref: &ActionHash) -> ExternResult<bool> {
    let order_types: [ScopedEntryDefIndex; 2] = [UnitEntryTypes::DeliveryOrder.try_into()?, UnitEntryTypes::PickupOrder.try_into()?];
    let activity = must_get_agent_activity(requester.clone(), ChainFilter::until_hash(chain_top.clone(), claim_ref.clone()))?;
    for item in activity {
        let ActionData::Create(create) = &item.action.hashed.content.data else { continue };
        let EntryType::App(def) = &create.entry_type else { continue };
        if !order_types.iter().any(|t| t.zome_index == def.zome_index && t.zome_type == def.entry_index) {
            continue;
        }
        let entry = match item.cached_entry {
            Some(entry) => entry,
            None => must_get_entry(create.entry_hash.clone())?.content,
        };
        let Entry::App(bytes) = entry else { continue };
        let redeems = |sb: SerializedBytes| -> bool {
            DeliveryOrder::try_from(sb.clone()).map(|o| o.bag_claim_ref.as_ref() == Some(claim_ref)).unwrap_or(false)
                || PickupOrder::try_from(sb).map(|o| o.bag_claim_ref.as_ref() == Some(claim_ref)).unwrap_or(false)
        };
        if redeems(SerializedBytes::from(bytes)) {
            return Ok(true);
        }
    }
    Ok(false)
}
