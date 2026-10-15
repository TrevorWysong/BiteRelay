//! Pickup-order validation: creation, and its own (driverless) status
//! state machine.

use super::*;
use crate::holds::{check_hold, terms_of, ExpectedHold};
use dispatch_types::HoldPurpose;
use crate::store_answer::{check_cancellation, check_ready_by, CancelledFrom, OrderUpdate};
use crate::checks::{check_bag_claim, check_order_rate, check_pricing, store_version, ClaimedFor, OrderPricing};
use crate::claims::resolve_original_creation;

/// `PickupOrder`'s sibling of `validate_new_order` -- same shape, minus
/// every check that only makes sense once a driver is in the loop
/// (dropoff/geohash, accepted_bid, delivery_receipts all simply don't
/// exist on this entry type at all, so there's nothing to check there).
pub(crate) fn validate_new_pickup_order(order: &PickupOrder, author: &AgentPubKey, action_timestamp: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    if &order.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a pickup order can only be authored by its own requester".into(),
        ));
    }
    if order.status != PickupStatus::Placed {
        return Ok(ValidateCallbackResult::Invalid("a new pickup order must start Placed".into()));
    }
    if order.food_hold.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new pickup order's food is held when the store accepts it".into()));
    }
    if order.cancellation.is_some() || order.ready_by.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new pickup order can't already be accepted or cancelled".into()));
    }
    if let Some(reason) = check_merchant_owns_catalog(&order.merchant, &order.catalog_ref)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    let store = match store_version(&order.catalog_ref, &order.catalog_version)? {
        Ok(store) => store,
        Err(reason) => return Ok(ValidateCallbackResult::Invalid(reason)),
    };
    let sealed = [("kitchen_note", order.kitchen_note.as_ref()), ("sealed_customer_name", order.sealed_customer_name.as_ref())];
    if let Some(reason) = sealed.into_iter().find_map(|(field, value)| value.and_then(|v| relay_integrity_support::sealed_problem(field, v, relay_integrity_support::limits::MAX_SEALED_BYTES))) {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    let pricing = OrderPricing {
        requester: &order.requester,
        catalog_ref: &order.catalog_ref,
        lines: &order.lines,
        order_total: order.order_total,
        promo_code_ref: order.promo_code_ref.as_ref(),
        bag_claim_ref: order.bag_claim_ref.as_ref(),
        loyalty_proof: &order.loyalty_proof,
        placed_at: action_timestamp,
        store: &store,
        tax_cents: order.tax_cents,
    };
    if let Some(reason) = check_pricing(pricing)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    if let Some(reason) = check_order_rate(author, action_timestamp, prev_action)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    if let Some(claim_ref) = &order.bag_claim_ref {
        if let Some(reason) = check_bag_claim(claim_ref, &order.requester, ClaimedFor::Pickup, prev_action)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    }
    Ok(ValidateCallbackResult::Valid)
}

pub(crate) fn validate_pickup_order_transition(
    order: &PickupOrder,
    author: &AgentPubKey,
    original_action_hash: &ActionHash,
    action_timestamp: Timestamp,
) -> ExternResult<ValidateCallbackResult> {
    let prior_record = must_get_valid_record(original_action_hash.clone())?;
    let prior: PickupOrder = prior_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "original_action_hash does not point at a PickupOrder entry".into()
        )))?;

    let Some(required_author) = prior.status.transition_requirement(&order.status) else {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "illegal status transition: {:?} -> {:?}",
            prior.status, order.status
        )));
    };

    let is_requester_or_merchant = &prior.requester == author || &prior.merchant == author;
    let authorized = match required_author {
        RequiredAuthor::Requester => &prior.requester == author,
        RequiredAuthor::Merchant => &prior.merchant == author,
        RequiredAuthor::RequesterOrMerchant => is_requester_or_merchant,
        // Never produced by PickupStatus::transition_requirement -- there is
        // no driver at all for this entry type.
        RequiredAuthor::AcceptedProvider | RequiredAuthor::RequesterOrProvider | RequiredAuthor::MerchantOrProvider | RequiredAuthor::AnyParty => false,
    };
    if !authorized {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "transition {:?} -> {:?} requires author role {:?}, but the author holds none of the roles it permits",
            prior.status, order.status, required_author
        )));
    }

    let update = OrderUpdate {
        requester: &prior.requester,
        merchant: &prior.merchant,
        author,
        prior_written_at: prior_record.action().timestamp(),
        written_at: action_timestamp,
    };
    let accepting = prior.status == PickupStatus::Placed && order.status == PickupStatus::MerchantConfirmed;
    if accepting && !update.within_response_window() {
        return Ok(ValidateCallbackResult::Invalid("the store's window to accept this order has passed".into()));
    }
    if let Some(reason) = check_ready_by(&update, accepting, prior.ready_by, order.ready_by) {
        return Ok(ValidateCallbackResult::Invalid(reason.into()));
    }
    let cancelled_from = (prior.status != PickupStatus::Cancelled && order.status == PickupStatus::Cancelled).then_some(match prior.status {
        PickupStatus::Placed => CancelledFrom::Placed,
        PickupStatus::Disputed => CancelledFrom::Disputed,
        _ => CancelledFrom::Elsewhere,
    });
    if let Some(reason) = check_cancellation(&update, cancelled_from, &prior.cancellation, &order.cancellation) {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }

    // The store accepts an order only once its food is paid for.
    if accepting {
        let order_original = resolve_original_creation(original_action_hash.clone())?;
        let Some(terms) = terms_of(&order_original)? else { return Ok(ValidateCallbackResult::Invalid("not an order".into())) };
        if let Err(reason) = check_hold(&order.food_hold, ExpectedHold { order_original: &order_original, terms: &terms, purpose: HoldPurpose::Food, bid: None })? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if prior.food_hold != order.food_hold {
        return Ok(ValidateCallbackResult::Invalid("food_hold is set once, when the store accepts the order".into()));
    }

    let unchanged = prior.requester == order.requester
        && prior.merchant == order.merchant
        && prior.catalog_ref == order.catalog_ref
        && prior.catalog_version == order.catalog_version
        && prior.lines == order.lines
        && prior.loyalty_proof == order.loyalty_proof
        && prior.order_total == order.order_total
        && prior.requested_at == order.requested_at
        && prior.kitchen_note == order.kitchen_note
        && prior.sealed_customer_name == order.sealed_customer_name
        && prior.promo_code_ref == order.promo_code_ref
        && prior.bag_claim_ref == order.bag_claim_ref;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "a pickup order update may only change its status -- every other field must stay the same".into(),
        ));
    }

    Ok(ValidateCallbackResult::Valid)
}
