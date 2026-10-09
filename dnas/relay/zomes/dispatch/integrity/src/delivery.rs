//! Delivery-order validation: creation, the status state machine, the
//! leg-attestation completion gate, and delivery disputes.

use super::*;
use relay_integrity_support::decode;
use crate::store_answer::{check_cancellation, check_ready_by, CancelledFrom, OrderUpdate};
use crate::checks::{check_bag_claim, check_pricing, ClaimedFor, OrderPricing};
use crate::disputes::*;

pub(crate) fn validate_new_order(order: &DeliveryOrder, author: &AgentPubKey, action_timestamp: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    if &order.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a delivery order can only be authored by its own requester".into(),
        ));
    }
    if order.cancellation.is_some() || order.collateral_hold.is_some() || order.ready_by.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new order can't already be accepted, cancelled or picked up".into()));
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
    if order.dispute_ref.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new order cannot already have a dispute_ref".into()));
    }
    if let Some(reason) = check_merchant_owns_catalog(&order.merchant, &order.catalog_ref)? {
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

/// Required leg kinds for a delivery's completion chain (3-party:
/// merchant -> driver -> customer, so 2 legs) -- see `Leg`'s doc comment.
pub(crate) const REQUIRED_LEG_KINDS: [LegKind; 2] = [LegKind::MerchantHandoff, LegKind::CustomerHandoff];

/// The actual completion gate, now run as part of deterministic validation
/// rather than trusted from the coordinator: every entry in
/// `delivery_receipts` must be a real `ReceiptAttestation` for a real `Leg`
/// that belongs to *this* order, and together they must cover every
/// required leg kind. Returns `Err(reason)` rather than bailing out with
/// `?` into `ValidateCallbackResult::Invalid` directly, so the caller can
/// build one consistent error message.
pub(crate) fn validate_delivery_receipts(order_original_creation: &ActionHash, receipts: &[ActionHash]) -> ExternResult<Result<(), String>> {
    let mut kinds_seen: Vec<LegKind> = Vec::new();
    for receipt_ref in receipts {
        let receipt_record = must_get_valid_record(receipt_ref.clone())?;
        // `ReceiptAttestation` is committed via countersigning, so its wire
        // shape is `Entry::CounterSign(session_data, bytes)`, not the plain
        // `Entry::App(bytes)` that `to_app_option` (Entry-agnostic, only
        // matches `Entry::App`) expects -- it would silently return `None`
        // here for every genuine receipt. The `TryFrom<&Entry>` impl that
        // `#[hdk_entry_helper]` generates handles both cases, so use that
        // instead.
        let Some(entry) = receipt_record.entry().as_option() else {
            return Ok(Err("a delivery_receipts entry has no entry data".into()));
        };
        let Ok(receipt) = ReceiptAttestation::try_from(entry) else {
            return Ok(Err("a delivery_receipts entry does not point at a ReceiptAttestation entry".into()));
        };
        let leg_record = must_get_valid_record(receipt.leg.clone())?;
        let Some(leg): Option<Leg> = leg_record.entry().to_app_option().map_err(|e| wasm_error!(e))? else {
            return Ok(Err("a delivery_receipts entry's receipt does not point at a Leg entry".into()));
        };
        let leg_order_creation = resolve_original_creation(leg.order_ref)?;
        if &leg_order_creation != order_original_creation {
            return Ok(Err("a delivery_receipts entry references a leg belonging to a different order".into()));
        }
        if !kinds_seen.contains(&leg.kind) {
            kinds_seen.push(leg.kind);
        }
    }
    for required in REQUIRED_LEG_KINDS {
        if !kinds_seen.contains(&required) {
            return Ok(Err(format!("missing an attested leg of kind {:?}", required)));
        }
    }
    Ok(Ok(()))
}

/// The dispute being first raised (`PickedUp`/`Delivered -> Disputed`, or
/// the `Cancelled -> Cancelled` cancellation-fairness case) -- extracted out
/// of `validate_order_transition`'s own dispute-ref handling so that
/// function's three-way branch (raise / resolve / resolve-cancellation)
/// reads as three named checks rather than one long inline block, same
/// pattern as `validate_delivery_receipts`/`validate_dispute_resolution_matches`
/// above. `is_accepted_provider`/`accepted_bidder` are passed in rather than
/// re-derived, since the caller already resolved them with the correct
/// prior-state context.
pub(crate) fn check_raising_dispute(
    prior: &DeliveryOrder,
    order: &DeliveryOrder,
    author: &AgentPubKey,
    is_accepted_provider: bool,
    accepted_bidder: &Option<AgentPubKey>,
    original_action_hash: &ActionHash,
) -> ExternResult<Result<(), String>> {
    if prior.dispute_ref.is_some() {
        return Ok(Err("dispute_ref must be empty before a dispute is first raised".into()));
    }
    let Some(new_dispute_ref) = &order.dispute_ref else {
        return Ok(Err("raising a dispute must set dispute_ref".into()));
    };
    // The order's *other* party relative to whoever raised this.
    let expected_respondent = if is_accepted_provider {
        prior.requester.clone()
    } else {
        match accepted_bidder {
            Some(bidder) => bidder.clone(),
            None => return Ok(Err("cannot raise a dispute on an order with no accepted bid".into())),
        }
    };
    let order_original_creation = resolve_original_creation(original_action_hash.clone())?;
    validate_new_dispute_ref(&order_original_creation, new_dispute_ref, author, &expected_respondent)
}

/// The `Disputed -> Delivered`/`Cancelled` resolution transition -- see
/// `check_raising_dispute`'s doc comment for why this is extracted.
pub(crate) fn check_resolving_dispute(prior: &DeliveryOrder, order: &DeliveryOrder, author: &AgentPubKey) -> ExternResult<Result<(), String>> {
    let Some(prior_dispute_ref) = &prior.dispute_ref else {
        return Ok(Err("a Disputed order with no dispute_ref cannot be resolved".into()));
    };
    let Some(new_dispute_ref) = &order.dispute_ref else {
        return Ok(Err("resolving a dispute must set dispute_ref to the resolved record".into()));
    };
    // dispute_ref is allowed to *advance* here, from the dispute's original
    // creation hash to its resolved-update hash -- must_get_valid_record is
    // literal, so validate_dispute_resolution_matches needs a reference that
    // already points directly at the Resolved content (the creation hash
    // would only ever show the original Open-status entry, the same
    // "get() is literal" gotcha as delivery_receipts elsewhere in this
    // file). Still must be the *same* dispute chain, not a swap to an
    // unrelated one.
    let new_dispute_original_creation = resolve_original_creation(new_dispute_ref.clone())?;
    if &new_dispute_original_creation != prior_dispute_ref {
        return Ok(Err("dispute_ref update must resolve back to the same dispute originally raised".into()));
    }
    validate_dispute_resolution_matches(new_dispute_ref, &order.status, author)
}

/// The cancellation-fairness resolution transition (`Cancelled -> Cancelled`
/// with `prior.dispute_ref` already set) -- see `check_raising_dispute`'s
/// doc comment for why this is extracted. Arbitrator-only authorship is
/// already enforced by `validate_order_transition`'s own `authorized` check
/// before this runs, so there's nothing further to check on that front here.
pub(crate) fn check_resolving_cancellation_dispute(prior: &DeliveryOrder, order: &DeliveryOrder, author: &AgentPubKey) -> ExternResult<Result<(), String>> {
    // Safe: callers only reach this once resolving_cancellation_dispute has
    // already established prior.dispute_ref.is_some().
    let prior_dispute_ref = prior.dispute_ref.as_ref().unwrap();
    let Some(new_dispute_ref) = &order.dispute_ref else {
        return Ok(Err("dispute_ref must remain set while resolving a cancellation dispute".into()));
    };
    if new_dispute_ref == prior_dispute_ref {
        return Ok(Err("applying a cancellation dispute resolution must advance dispute_ref to the resolved record".into()));
    }
    let new_dispute_original_creation = resolve_original_creation(new_dispute_ref.clone())?;
    if &new_dispute_original_creation != prior_dispute_ref {
        return Ok(Err("dispute_ref update must resolve back to the same dispute originally raised".into()));
    }
    validate_cancellation_dispute_resolution_matches(new_dispute_ref, author)
}

/// The driver's collateral hold on a pickup: a `CollateralHold` the
/// assigned driver wrote, to the customer, for this order, for exactly what
/// their bid committed.
fn check_collateral_hold(order: &DeliveryOrder, prior: &DeliveryOrder, order_original_creation: &ActionHash) -> ExternResult<Result<(), String>> {
    let Some(hold_ref) = &order.collateral_hold else {
        return Ok(Err("picking an order up requires the driver's collateral hold".into()));
    };
    let Some(bid_ref) = &prior.accepted_bid else { return Ok(Err("an order is only picked up by its assigned driver".into())) };
    let Some(bid) = decode::<Bid>(&must_get_valid_record(bid_ref.clone())?) else { return Ok(Err("accepted_bid is not a Bid".into())) };
    let hold_record = must_get_valid_record(hold_ref.clone())?;
    let Some(hold) = decode::<LedgerTransaction>(&hold_record) else { return Ok(Err("collateral_hold is not a ledger transaction".into())) };
    let matches = hold.reason == TxnReason::CollateralHold
        && hold_record.action().author() == &bid.bidder
        && hold.from == bid.bidder
        && hold.to == prior.requester
        && hold.amount == bid.collateral
        && &hold.related_order == order_original_creation;
    Ok(if matches { Ok(()) } else { Err("collateral_hold must be the assigned driver's committed collateral, posted to the customer for this order".into()) })
}

pub(crate) fn validate_order_transition(
    order: &DeliveryOrder,
    author: &AgentPubKey,
    original_action_hash: &ActionHash,
    action_timestamp: Timestamp,
) -> ExternResult<ValidateCallbackResult> {
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

    // Computed here (rather than down with the rest of the dispute_ref
    // handling below) because the (Cancelled, Cancelled) pair needs it to
    // pick the right required-author check too: that one status pair
    // covers *both* raising a cancellation-fairness dispute (Any: req/
    // merchant/provider) and applying its resolution (arbitrator only) --
    // transition_requirement's table has no way to express two different
    // requirements for the same pair, so the split happens here, keyed off
    // prior.dispute_ref, same signal the dispute_ref block below uses.
    let resolving_cancellation_dispute =
        prior.status == DeliveryStatus::Cancelled && order.status == DeliveryStatus::Cancelled && prior.dispute_ref.is_some();

    let authorized = match required_author {
        RequiredAuthor::Requester => &prior.requester == author,
        RequiredAuthor::Merchant => &prior.merchant == author,
        RequiredAuthor::RequesterOrMerchant => is_requester_or_merchant,
        RequiredAuthor::AcceptedProvider => is_accepted_provider,
        RequiredAuthor::Any if resolving_cancellation_dispute => relay_governance::is_arbitrator(author)?,
        RequiredAuthor::Any => is_requester_or_merchant || is_accepted_provider,
        RequiredAuthor::Arbitrator => relay_governance::is_arbitrator(author)?,
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
    if store_accepting && !update.within_response_window() {
        return Ok(ValidateCallbackResult::Invalid("the store's window to accept this order has passed".into()));
    }
    if let Some(reason) = check_ready_by(&update, store_accepting, prior.ready_by, order.ready_by) {
        return Ok(ValidateCallbackResult::Invalid(reason.into()));
    }
    let cancelled_from = (prior.status != DeliveryStatus::Cancelled && order.status == DeliveryStatus::Cancelled).then(|| match prior.status {
        DeliveryStatus::Placed => CancelledFrom::Placed,
        DeliveryStatus::Disputed => CancelledFrom::Disputed,
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
    // The driver posts their collateral in the update that picks the order
    // up -- not before, not after, and never changed.
    let picking_up = prior.status == DeliveryStatus::DriverEnRouteToMerchant && order.status == DeliveryStatus::PickedUp;
    if picking_up {
        let order_original_creation = resolve_original_creation(original_action_hash.clone())?;
        if let Err(reason) = check_collateral_hold(order, &prior, &order_original_creation)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if prior.collateral_hold != order.collateral_hold {
        return Ok(ValidateCallbackResult::Invalid("collateral_hold is set once, by the update that picks the order up".into()));
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
    // delivery_receipts may only be populated, once, during PickedUp ->
    // Delivered -- and when it is, it must actually check out: every
    // referenced ReceiptAttestation must be real, belong to a Leg on *this*
    // order, and together cover every required leg kind. This is the
    // completion gate that used to live only in `dispatch::complete_delivery`
    // (trusted from the coordinator) -- now it's enforced here too, so a
    // direct `update_entry` bypassing that coordinator function can't skip it.
    if prior.status == DeliveryStatus::PickedUp && order.status == DeliveryStatus::Delivered {
        if !prior.delivery_receipts.is_empty() {
            return Ok(ValidateCallbackResult::Invalid(
                "delivery_receipts must be empty before the Delivered transition sets it".into(),
            ));
        }
        let order_original_creation = resolve_original_creation(original_action_hash.clone())?;
        if let Err(reason) = validate_delivery_receipts(&order_original_creation, &order.delivery_receipts)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if prior.delivery_receipts != order.delivery_receipts {
        return Ok(ValidateCallbackResult::Invalid(
            "delivery_receipts may only be set, once, during the PickedUp -> Delivered transition".into(),
        ));
    }

    // dispute_ref: set once, when a dispute is first raised (PickedUp/
    // Delivered -> Disputed, or Cancelled -> Cancelled for a cancellation-
    // fairness dispute -- architecture plan §11.1, which reuses this exact
    // block unchanged: an order cancelled from Open never had an accepted
    // bid, so the "cannot raise a dispute on an order with no accepted bid"
    // check below already correctly refuses a fairness dispute where there
    // was never a provider to have one with), then immutable except that
    // the resolution transitions (Disputed -> Delivered/Cancelled) must
    // find it pointing at a genuinely Resolved dispute whose ruling matches
    // the target status -- see architecture plan §8. This is what stops a
    // peer from calling update_entry directly to flip a Disputed order to
    // Delivered/Cancelled without a real arbitrator ruling behind it, same
    // posture as the delivery_receipts completion gate above. A
    // cancellation-fairness dispute has no equivalent resolution transition
    // here at all -- the order is already terminal, so resolving one only
    // ever touches the Dispute entry and a ledger transaction, never this
    // order (see `dispatch::apply_cancellation_dispute_resolution`).
    // The (Cancelled, Cancelled) same-status pair covers *both* raising a
    // cancellation-fairness dispute (dispute_ref unset -> set) and applying
    // its resolution (dispute_ref advancing) -- transition_requirement's
    // table can't distinguish them (same status pair either way, and the
    // raise side deliberately needs RequiredAuthor::Any while the resolve
    // side needs an arbitrator only), so that distinction is made here,
    // from prior.dispute_ref, same as the other two dispute cases below.
    // (resolving_cancellation_dispute is already computed above, alongside
    // the `authorized` check it also feeds into.)
    let raising_dispute = (matches!(prior.status, DeliveryStatus::PickedUp | DeliveryStatus::Delivered)
        && order.status == DeliveryStatus::Disputed)
        || (prior.status == DeliveryStatus::Cancelled && order.status == DeliveryStatus::Cancelled && prior.dispute_ref.is_none());
    let resolving_dispute =
        prior.status == DeliveryStatus::Disputed && matches!(order.status, DeliveryStatus::Delivered | DeliveryStatus::Cancelled);
    if raising_dispute {
        if let Err(reason) = check_raising_dispute(&prior, order, author, is_accepted_provider, &accepted_bidder, original_action_hash)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if resolving_dispute {
        if let Err(reason) = check_resolving_dispute(&prior, order, author)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if resolving_cancellation_dispute {
        if let Err(reason) = check_resolving_cancellation_dispute(&prior, order, author)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if prior.dispute_ref != order.dispute_ref {
        return Ok(ValidateCallbackResult::Invalid(
            "dispute_ref may only change when a dispute is raised or resolved".into(),
        ));
    }

    let unchanged = prior.requester == order.requester
        && prior.merchant == order.merchant
        && prior.catalog_ref == order.catalog_ref
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
        && prior.bag_claim_ref == order.bag_claim_ref;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "an order update may only change status (and accepted_bid, on acceptance) -- every other field must stay the same".into(),
        ));
    }

    Ok(ValidateCallbackResult::Valid)
}
