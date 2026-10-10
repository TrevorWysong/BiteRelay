//! Delivery-order validation: creation, the status state machine, the
//! pickup and drop-off proof gates, and the customer's claim that an order
//! never arrived.

use super::*;
use crate::holds::{check_hold, terms_of, ExpectedHold};
use dispatch_types::HoldPurpose;
use relay_integrity_support::limits::MAX_SEALED_BYTES;
use relay_integrity_support::{decode, sealed_problem};
use crate::store_answer::{check_cancellation, check_ready_by, CancelledFrom, OrderUpdate};
use crate::checks::{check_bag_claim, check_pricing, ClaimedFor, OrderPricing};
use crate::claims::{resolve_original_creation, wrote_update_of};
use attestation_types::dropoff_proof;

pub(crate) fn validate_new_order(order: &DeliveryOrder, author: &AgentPubKey, action_timestamp: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    if &order.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a delivery order can only be authored by its own requester".into(),
        ));
    }
    if order.cancellation.is_some() || order.ready_by.is_some() || order.food_hold.is_some() || order.driver_pay_hold.is_some() || order.subsidy_hold.is_some() || order.collateral_hold.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new order can't already be accepted, cancelled or picked up".into()));
    }
    if order.pin_commitment.len() != 32 {
        return Ok(ValidateCallbackResult::Invalid("a delivery commits to the customer's handoff code (32 bytes)".into()));
    }
    if !order.pickup_commitment.is_empty() || order.sealed_pickup_code.is_some() || order.pickup_proof.is_some() {
        return Ok(ValidateCallbackResult::Invalid("the store's pickup code is set when it accepts the order".into()));
    }
    if order.door_risk_accepted != (order.dropoff_preference == DropoffPreference::LeaveAtDoor) {
        return Ok(ValidateCallbackResult::Invalid("an order left at the door needs its customer to accept the risk -- and only such an order".into()));
    }
    if order.delivery_subsidy_percent > 100 {
        return Ok(ValidateCallbackResult::Invalid("delivery_subsidy_percent must be between 0 and 100".into()));
    }
    match (&order.status, order.requested_delivery_time) {
        (DeliveryStatus::Placed, None) => {}
        (DeliveryStatus::Scheduled, Some(_)) => {}
        _ => {
            return Ok(ValidateCallbackResult::Invalid(
                "a new order must start Placed (for the store to accept) with no requested_delivery_time, or Scheduled with one set".into(),
            ))
        }
    }
    if order.accepted_bid.is_some() || order.driver_dropoff.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new order cannot already have an accepted bid".into()));
    }
    if !order.delivery_receipts.is_empty() {
        return Ok(ValidateCallbackResult::Invalid("a new order cannot already have delivery receipts".into()));
    }
    if let Some(reason) = check_merchant_owns_catalog(&order.merchant, &order.catalog_ref)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    if let Some(reason) = check_store_terms(order)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    if let Some(reason) = sealed_fields_problem(order) {
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
    };
    if let Some(reason) = check_pricing(pricing)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    if let Some(claim_ref) = &order.bag_claim_ref {
        if let Some(reason) = check_bag_claim(claim_ref, &order.requester, ClaimedFor::Delivery, prev_action)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    }
    Ok(ValidateCallbackResult::Valid)
}

/// The store's terms a delivery was placed under, from the version it cites
/// (`catalog_version`): its fee split, and its delivery radius -- checked
/// against the drop-off's public cell, the nearest the store could be to it
/// (the exact point is sealed). `Some(reason)` if they don't hold.
fn check_store_terms(order: &DeliveryOrder) -> ExternResult<Option<String>> {
    if resolve_original_creation(order.catalog_version.clone())? != order.catalog_ref {
        return Ok(Some("catalog_version must be a version of the order's own store".into()));
    }
    let Some(store) = decode::<MerchantCatalog>(&must_get_valid_record(order.catalog_version.clone())?) else {
        return Ok(Some("catalog_version must be a store".into()));
    };
    if order.delivery_subsidy_percent != store.delivery_subsidy_percent {
        return Ok(Some("an order's fee split is its store's, as it stood when the order was placed".into()));
    }
    if order.dropoff_geohash.chars().count() != DROPOFF_GEOHASH_PRECISION {
        return Ok(Some(format!("a drop-off's area is a geohash of {DROPOFF_GEOHASH_PRECISION} characters")));
    }
    match relay_types::distance_to_cell_km(store.location, &order.dropoff_geohash) {
        Some(distance) if distance <= store.max_delivery_radius_km => Ok(None),
        Some(_) => Ok(Some("the drop-off is outside the store's delivery radius".into())),
        None => Ok(Some("dropoff_geohash isn't a geohash".into())),
    }
}

/// Why one of an order's sealed fields is too large, if one is: each is a
/// note, a name, an address or a handoff code -- small, and stored by every
/// authority for the order.
pub(crate) fn sealed_fields_problem(order: &DeliveryOrder) -> Option<String> {
    let sealed = [
        ("sealed_dropoff", Some(&order.sealed_dropoff)),
        ("driver_dropoff", order.driver_dropoff.as_ref()),
        ("kitchen_note", order.kitchen_note.as_ref()),
        ("sealed_customer_name", order.sealed_customer_name.as_ref()),
        ("sealed_pin", Some(&order.sealed_pin)),
        ("sealed_pickup_code", order.sealed_pickup_code.as_ref()),
    ];
    sealed.into_iter().find_map(|(field, value)| value.and_then(|v| sealed_problem(field, v, MAX_SEALED_BYTES)))
}

/// The drop-off gate: `delivery_receipts` must prove the order reached its
/// customer -- the driver's drop-off carrying the customer's scanned code,
/// the customer's own acknowledgment of it, or (for an order the customer
/// chose to have left at the door, accepting the risk) the driver's
/// drop-off left there. The attestation zome's validation already holds
/// each to its author and order version; this checks they're for *this*
/// order and include one such proof. `Err(reason)` if not.
pub(crate) fn validate_delivery_receipts(order_original_creation: &ActionHash, receipts: &[ActionHash]) -> ExternResult<Result<(), String>> {
    for proof_ref in receipts {
        let record = must_get_valid_record(proof_ref.clone())?;
        let leg = if let Some(leg) = decode::<Leg>(&record) {
            leg
        } else if let Some(receipt) = decode::<ReceiptAttestation>(&record) {
            let Some(leg) = decode::<Leg>(&must_get_valid_record(receipt.leg.clone())?) else {
                return Ok(Err("a delivery receipt does not acknowledge a handoff".into()));
            };
            leg
        } else {
            return Ok(Err("delivery_receipts may only hold handoffs and their receipts".into()));
        };
        if &resolve_original_creation(leg.order_ref.clone())? != order_original_creation {
            return Ok(Err("a delivery receipt belongs to a different order".into()));
        }
    }
    match dropoff_proof(receipts)? {
        Some(_) => Ok(Ok(())),
        None => Ok(Err("completing a delivery needs proof the customer has it: their scanned code, their own confirmation, or a drop-off left at the door as they chose".into())),
    }
}

/// The driver's proof they collected the order from the store: their
/// pickup leg carrying the store's scanned code, or the store's own
/// acknowledgment of their pickup leg.
fn validate_pickup_proof(order_original_creation: &ActionHash, proof: &ActionHash, merchant: &AgentPubKey) -> ExternResult<Result<(), &'static str>> {
    let record = must_get_valid_record(proof.clone())?;
    let leg = if let Some(leg) = decode::<Leg>(&record) {
        if leg.revealed_pin.is_none() {
            return Ok(Err("a pickup leg proves the pickup only with the store's scanned code"));
        }
        leg
    } else if let Some(receipt) = decode::<ReceiptAttestation>(&record) {
        if record.action().author() != merchant {
            return Ok(Err("only the store acknowledges a pickup"));
        }
        let Some(leg) = decode::<Leg>(&must_get_valid_record(receipt.leg)?) else { return Ok(Err("a pickup receipt must acknowledge a handoff")) };
        leg
    } else {
        return Ok(Err("pickup_proof must be the driver's pickup or the store's acknowledgment of it"));
    };
    let ours = leg.kind == LegKind::MerchantHandoff && &resolve_original_creation(leg.order_ref)? == order_original_creation;
    Ok(if ours { Ok(()) } else { Err("pickup_proof must be about this order's pickup") })
}

pub(crate) fn validate_order_transition(
    order: &DeliveryOrder,
    author: &AgentPubKey,
    original_action_hash: &ActionHash,
    action_timestamp: Timestamp,
    prev_action: Option<&ActionHash>,
) -> ExternResult<ValidateCallbackResult> {
    let Some(prev_action) = prev_action else { return Ok(ValidateCallbackResult::Invalid("an order update can't open a chain".into())) };
    let prior_record = must_get_valid_record(original_action_hash.clone())?;
    let prior: DeliveryOrder = prior_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "original_action_hash does not point at a DeliveryOrder entry".into()
        )))?;

    let Some(required_author) = prior.status.transition_requirement(&order.status) else {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "illegal status transition: {:?} -> {:?}",
            prior.status, order.status
        )));
    };

    let is_requester_or_merchant = &prior.requester == author || &prior.merchant == author;
    let accepted_bidder: Option<AgentPubKey> = match &prior.accepted_bid {
        Some(bid_ref) => {
            let bid_record = must_get_valid_record(bid_ref.clone())?;
            let bid: Bid = bid_record
                .entry()
                .to_app_option()
                .map_err(|e| wasm_error!(e))?
                .ok_or(wasm_error!(WasmErrorInner::Guest(
                    "accepted_bid does not point at a Bid entry".into()
                )))?;
            Some(bid.bidder)
        }
        None => None,
    };
    let is_accepted_provider = accepted_bidder.as_ref() == Some(author);

    let authorized = match required_author {
        RequiredAuthor::Requester => &prior.requester == author,
        RequiredAuthor::Merchant => &prior.merchant == author,
        RequiredAuthor::RequesterOrMerchant => is_requester_or_merchant,
        RequiredAuthor::AcceptedProvider => is_accepted_provider,
        RequiredAuthor::RequesterOrProvider => &prior.requester == author || is_accepted_provider,
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
    let store_accepting = prior.status == DeliveryStatus::Placed && order.status == DeliveryStatus::Open;
    // The store's pickup code: committed when it accepts the order, with its
    // own sealed copy, and never changed after.
    let pickup_code_ok = if store_accepting {
        order.pickup_commitment.len() == 32 && order.sealed_pickup_code.is_some()
    } else {
        prior.pickup_commitment == order.pickup_commitment && prior.sealed_pickup_code == order.sealed_pickup_code
    };
    if let Some(reason) = sealed_fields_problem(order) {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    if !pickup_code_ok {
        return Ok(ValidateCallbackResult::Invalid("the store commits to its pickup code (32 bytes) when it accepts the order, and never changes it".into()));
    }
    if store_accepting && !update.within_response_window() {
        return Ok(ValidateCallbackResult::Invalid("the store's window to accept this order has passed".into()));
    }
    if let Some(reason) = check_ready_by(&update, store_accepting, prior.ready_by, order.ready_by) {
        return Ok(ValidateCallbackResult::Invalid(reason.into()));
    }
    let cancelled_from = (prior.status != DeliveryStatus::Cancelled && order.status == DeliveryStatus::Cancelled).then_some(match prior.status {
        DeliveryStatus::Placed => CancelledFrom::Placed,
        _ => CancelledFrom::Elsewhere,
    });
    if let Some(reason) = check_cancellation(&update, cancelled_from, &prior.cancellation, &order.cancellation) {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }

    // Every field except status (and accepted_bid, only for the one
    // transition that's allowed to set it) must be unchanged. Without this,
    // an otherwise-authorized author could smuggle changes to order_total,
    // lines, the drop-off, or swap accepted_bid to a different bid entirely
    // while making an unrelated, legitimately-authorized status update.
    let accepting = prior.status == DeliveryStatus::Open && order.status == DeliveryStatus::BidAccepted;
    let accepted_bid_ok = if accepting {
        prior.accepted_bid.is_none() && order.accepted_bid.is_some()
    } else {
        prior.accepted_bid == order.accepted_bid
    };
    if !accepted_bid_ok {
        return Ok(ValidateCallbackResult::Invalid(
            "accepted_bid may only be set, once, during the Open -> BidAccepted transition".into(),
        ));
    }
    // The driver's sealed copy of the drop-off arrives with the acceptance
    // (only the requester can author it -- see the transition table) and
    // never changes after. What it contains can't be checked: it's sealed.
    let driver_dropoff_ok = if accepting {
        prior.driver_dropoff.is_none() && order.driver_dropoff.is_some()
    } else {
        prior.driver_dropoff == order.driver_dropoff
    };
    if !driver_dropoff_ok {
        return Ok(ValidateCallbackResult::Invalid(
            "driver_dropoff must be set when a bid is accepted, and never changed".into(),
        ));
    }
    // The money behind each step, set aside by whoever owes it and cited
    // by the step that needs it: the customer's food when the store
    // accepts, the driver's pay when the customer accepts a bid, the
    // store's fee share when it starts preparing, the driver's collateral
    // when they pick the order up. Each is set once and never changes.
    let picking_up = prior.status == DeliveryStatus::DriverEnRouteToMerchant && order.status == DeliveryStatus::PickedUp;
    let confirming = prior.status == DeliveryStatus::BidAccepted && order.status == DeliveryStatus::MerchantConfirmed;
    let order_original = resolve_original_creation(original_action_hash.clone())?;
    let Some(terms) = terms_of(&order_original)? else { return Ok(ValidateCallbackResult::Invalid("not an order".into())) };
    let bid_ref = if accepting { order.accepted_bid.clone() } else { prior.accepted_bid.clone() };
    let bid = match &bid_ref {
        Some(bid_ref) => decode::<Bid>(&must_get_valid_record(bid_ref.clone())?),
        None => None,
    };
    // Each hold: whether this is the step that places it, the hold before
    // and after, what it must be for, and its field.
    type HoldStep<'a> = (bool, &'a Option<ActionHash>, &'a Option<ActionHash>, Option<HoldPurpose>, &'static str);
    let steps: [HoldStep; 4] = [
        (store_accepting, &prior.food_hold, &order.food_hold, Some(HoldPurpose::Food), "food_hold"),
        (accepting, &prior.driver_pay_hold, &order.driver_pay_hold, bid_ref.clone().map(|bid| HoldPurpose::DriverPay { bid }), "driver_pay_hold"),
        (confirming, &prior.subsidy_hold, &order.subsidy_hold, bid_ref.clone().map(|bid| HoldPurpose::Subsidy { bid }), "subsidy_hold"),
        (picking_up, &prior.collateral_hold, &order.collateral_hold, bid_ref.clone().map(|bid| HoldPurpose::Collateral { bid }), "collateral_hold"),
    ];
    for (this_step, before, after, purpose, field) in steps {
        if !this_step {
            if before != after {
                return Ok(ValidateCallbackResult::Invalid(format!("{field} is set once, by the step it pays for")));
            }
            continue;
        }
        if before.is_some() {
            return Ok(ValidateCallbackResult::Invalid(format!("{field} is already set")));
        }
        let Some(purpose) = purpose else { return Ok(ValidateCallbackResult::Invalid("this step needs the order's accepted bid".into())) };
        let needs_bid = !matches!(purpose, HoldPurpose::Food);
        let expected = ExpectedHold { order_original: &order_original, terms: &terms, purpose, bid: if needs_bid { bid.as_ref() } else { None } };
        if let Err(reason) = check_hold(after, expected)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    }
    // A scheduled order can only actually open once its requested time has
    // arrived. Deliberately checked against *this action's own recorded
    // timestamp* (fixed, agreed-upon by every validator who looks at this
    // same action), not a fresh `sys_time()` call inside validate() -- the
    // latter would be non-deterministic, since different peers validating
    // the same action at different real-world moments could disagree.
    if prior.status == DeliveryStatus::Scheduled && order.status == DeliveryStatus::Placed {
        let due = prior.requested_delivery_time.unwrap_or(Timestamp(0));
        if action_timestamp < due {
            return Ok(ValidateCallbackResult::Invalid(
                "a scheduled order cannot open for bidding before its requested_delivery_time".into(),
            ));
        }
    }
    // The driver picks the order up on proof the store handed it over.
    if picking_up {
        let Some(proof) = &order.pickup_proof else {
            return Ok(ValidateCallbackResult::Invalid("picking an order up needs proof the store handed it over: its scanned code, or its acknowledgment".into()));
        };
        if let Err(reason) = validate_pickup_proof(&order_original, proof, &prior.merchant)? {
            return Ok(ValidateCallbackResult::Invalid(reason.into()));
        }
    } else if prior.pickup_proof != order.pickup_proof {
        return Ok(ValidateCallbackResult::Invalid("pickup_proof is set once, by the update picking the order up".into()));
    }
    // Delivered only on proof the customer has it, set once by the update
    // completing it -- final: there's no claim from Delivered.
    let completing = matches!(prior.status, DeliveryStatus::PickedUp | DeliveryStatus::Disputed) && order.status == DeliveryStatus::Delivered;
    if completing {
        if !prior.delivery_receipts.is_empty() {
            return Ok(ValidateCallbackResult::Invalid("delivery_receipts are set once, by the update completing the order".into()));
        }
        if let Err(reason) = validate_delivery_receipts(&order_original, &order.delivery_receipts)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if prior.delivery_receipts != order.delivery_receipts {
        return Ok(ValidateCallbackResult::Invalid("delivery_receipts are set once, by the update completing the order".into()));
    }
    // The customer's claim it never arrived. Their own decisions on another
    // branch of the order bind them: a customer who cancelled it (and so
    // owes the driver's fee) can't also claim it back.
    let claiming = prior.status == DeliveryStatus::PickedUp && order.status == DeliveryStatus::Disputed;
    if claiming && wrote_update_of(author, prev_action, &order_original, |v| v.status == DeliveryStatus::Cancelled)? {
        return Ok(ValidateCallbackResult::Invalid("a customer who cancelled an order can't claim it never arrived".into()));
    }

    let unchanged = prior.requester == order.requester
        && prior.merchant == order.merchant
        && prior.catalog_ref == order.catalog_ref
        && prior.catalog_version == order.catalog_version
        && prior.lines == order.lines
        && prior.loyalty_proof == order.loyalty_proof
        && prior.order_total == order.order_total
        && prior.sealed_dropoff == order.sealed_dropoff
        && prior.kitchen_note == order.kitchen_note
        && prior.sealed_customer_name == order.sealed_customer_name
        && prior.dropoff_geohash == order.dropoff_geohash
        && prior.max_delivery_fee == order.max_delivery_fee
        && prior.requested_at == order.requested_at
        && prior.tip_cents == order.tip_cents
        && prior.delivery_subsidy_percent == order.delivery_subsidy_percent
        && prior.requested_delivery_time == order.requested_delivery_time
        && prior.promo_code_ref == order.promo_code_ref
        && prior.dropoff_preference == order.dropoff_preference
        && prior.door_risk_accepted == order.door_risk_accepted
        && prior.bag_claim_ref == order.bag_claim_ref
        && prior.pin_commitment == order.pin_commitment
        && prior.sealed_pin == order.sealed_pin;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "an order update may only change status (and accepted_bid, on acceptance) -- every other field must stay the same".into(),
        ));
    }

    Ok(ValidateCallbackResult::Valid)
}
