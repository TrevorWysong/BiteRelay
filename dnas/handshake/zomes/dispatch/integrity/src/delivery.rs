//! Delivery-order validation: creation, the status state machine, the
//! pickup and drop-off proof gates, and the customer's claim that an order
//! never arrived.

use super::*;
use crate::holds::{check_hold, terms_of, ExpectedHold};
use dispatch_types::HoldPurpose;
use handshake_integrity_support::limits::MAX_SEALED_BYTES;
use handshake_integrity_support::{decode, sealed_problem};
use crate::store_answer::{check_cancellation, CancelledFrom, OrderUpdate};
use dispatch_types::lineage::{self, Version};
use dispatch_types::CollectRequest;
use handshake_integrity_support::beacon;
use crate::checks::{check_bag_claim, check_order_rate, check_pricing, store_version, ClaimedFor, OrderPricing};
use crate::claims::{resolve_original_creation, wrote_update_of};
use attestation_types::dropoff_proof;

pub(crate) fn validate_new_order(order: &DeliveryOrder, author: &AgentPubKey, action_timestamp: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    if &order.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a delivery order can only be authored by its own requester".into(),
        ));
    }
    let started = order.cancellation.is_some() || order.prep_minutes.is_some() || order.ready_by.is_some() || order.food_hold.is_some() || order.driver_pay_hold.is_some() || order.subsidy_hold.is_some() || order.collateral_hold.is_some();
    if started || order.collect_request.is_some() || order.beacon.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new order can't already be accepted, cancelled or picked up".into()));
    }
    if order.pin_commitment.len() != 32 {
        return Ok(ValidateCallbackResult::Invalid("a delivery commits to the customer's handoff code (32 bytes)".into()));
    }
    if !order.pickup_commitment.is_empty() || order.sealed_pickup_code.is_some() || order.pickup_proof.is_some() || order.collection_proof.is_some() {
        return Ok(ValidateCallbackResult::Invalid("the store's pickup code is set when it accepts the order".into()));
    }
    if order.door_risk_accepted != (order.dropoff_preference == DropoffPreference::LeaveAtDoor) {
        return Ok(ValidateCallbackResult::Invalid("an order left at the door needs its customer to accept the risk -- and only such an order".into()));
    }
    let amounts = [("tip_cents", Some(order.tip_cents)), ("max_delivery_fee", order.max_delivery_fee)];
    if let Some(problem) = amounts.into_iter().find_map(|(field, amount)| amount.and_then(|a| handshake_integrity_support::amount_problem(field, a))) {
        return Ok(ValidateCallbackResult::Invalid(problem));
    }
    // The driver answers for what they carry with collateral of its value
    // -- which is also how the network counts the orders they carry -- so a
    // delivery always carries something of value.
    if order.order_total == 0 {
        return Ok(ValidateCallbackResult::Invalid("a delivery must carry something of value: its total can't be zero".into()));
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
    if order.accepted_bid.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new order cannot already have an accepted bid".into()));
    }
    if !order.delivery_receipts.is_empty() {
        return Ok(ValidateCallbackResult::Invalid("a new order cannot already have delivery receipts".into()));
    }
    if let Some(reason) = check_merchant_owns_catalog(&order.merchant, &order.catalog_ref)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    let store = match check_store_terms(order)? {
        Ok(store) => store,
        Err(reason) => return Ok(ValidateCallbackResult::Invalid(reason)),
    };
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
        rewards: order.rewards.as_ref(),
        prev_action,
        placed_at: action_timestamp,
        store: &store,
        tax_cents: order.tax_cents,
        delivery: true,
        age_confirmed: false,
    };
    if let Some(reason) = check_pricing(pricing)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    if let Some(reason) = check_order_rate(author, action_timestamp, prev_action)? {
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
/// (the exact point is sealed). The store's terms, or why they don't hold.
fn check_store_terms(order: &DeliveryOrder) -> ExternResult<Result<MerchantCatalog, String>> {
    let store = match store_version(&order.catalog_ref, &order.catalog_version)? {
        Ok(store) => store,
        Err(reason) => return Ok(Err(reason)),
    };
    if order.delivery_subsidy_percent != store.delivery_subsidy_percent {
        return Ok(Err("an order's fee split is its store's, as it stood when the order was placed".into()));
    }
    if order.dropoff_geohash.chars().count() != DROPOFF_GEOHASH_PRECISION {
        return Ok(Err(format!("a drop-off's area is a geohash of {DROPOFF_GEOHASH_PRECISION} characters")));
    }
    Ok(match handshake_types::distance_to_cell_km(store.location, &order.dropoff_geohash) {
        Some(distance) if distance <= store.max_delivery_radius_km => Ok(store),
        Some(_) => Err("the drop-off is outside the store's delivery radius".into()),
        None => Err("dropoff_geohash isn't a geohash".into()),
    })
}

/// Why one of an order's sealed fields is too large, if one is: each is a
/// note, a name, an address or a handoff code -- small, and stored by every
/// authority for the order.
pub(crate) fn sealed_fields_problem(order: &DeliveryOrder) -> Option<String> {
    let sealed = [
        ("sealed_dropoff", Some(&order.sealed_dropoff)),
        ("kitchen_note", order.kitchen_note.as_ref()),
        ("sealed_customer_name", order.sealed_customer_name.as_ref()),
        ("sealed_wake", order.sealed_wake.as_ref()),
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

/// The driver's proof they collected the order from the store: the store's
/// own acknowledgment of their pickup leg -- it handed the order over, and
/// its chain says so.
fn validate_pickup_proof(order_original_creation: &ActionHash, proof: &ActionHash, merchant: &AgentPubKey, driver: &AgentPubKey) -> ExternResult<Result<(), &'static str>> {
    let record = must_get_valid_record(proof.clone())?;
    let Some(receipt) = decode::<ReceiptAttestation>(&record) else {
        return Ok(Err("pickup_proof must be the store's record of handing the order over"));
    };
    if record.action().author() != merchant {
        return Ok(Err("only the store records handing an order over"));
    }
    let Some(leg) = decode::<Leg>(&must_get_valid_record(receipt.leg)?) else { return Ok(Err("a pickup receipt must acknowledge a handoff")) };
    let ours = leg.kind == LegKind::MerchantHandoff && &leg.from == driver && &resolve_original_creation(leg.order_ref)? == order_original_creation;
    Ok(if ours { Ok(()) } else { Err("pickup_proof must be the store handing this order to this driver") })
}

/// What one update does, as these rules need it.
struct Step {
    store_accepting: bool,
    accepting: bool,
    committing: bool,
    cooking: bool,
    checking_in: bool,
    picking_up: bool,
    /// A driver leaving before pickup -- see `transition_requirement`.
    releasing: bool,
    collecting: bool,
    collected: bool,
    completing: bool,
    claiming: bool,
}

impl Step {
    fn of(prior: &DeliveryStatus, next: &DeliveryStatus, prior_has_driver: bool) -> Self {
        use DeliveryStatus::*;
        Self {
            store_accepting: *prior == Placed && *next == Open,
            accepting: *prior == Open && *next == BidAccepted,
            committing: *prior == BidAccepted && *next == DriverEnRouteToMerchant,
            cooking: *prior == DriverEnRouteToMerchant && *next == MerchantConfirmed,
            checking_in: *prior == MerchantConfirmed && *next == DriverAtStore,
            picking_up: *prior == DriverAtStore && *next == PickedUp,
            releasing: prior_has_driver && matches!(next, Open | Collecting),
            collecting: *prior != Collecting && *next == Collecting,
            collected: *prior == Collecting && *next == Collected,
            completing: matches!(prior, PickedUp | Disputed) && *next == Delivered,
            claiming: *prior == PickedUp && *next == Disputed,
        }
    }
}

pub(crate) fn validate_order_transition(
    order: &DeliveryOrder,
    author: &AgentPubKey,
    original_action_hash: &ActionHash,
    action_timestamp: Timestamp,
    prev_action: Option<&ActionHash>,
) -> ExternResult<ValidateCallbackResult> {
    match transition_problem(order, author, original_action_hash, action_timestamp, prev_action)? {
        Some(reason) => Ok(ValidateCallbackResult::Invalid(reason)),
        None => Ok(ValidateCallbackResult::Valid),
    }
}

fn transition_problem(order: &DeliveryOrder, author: &AgentPubKey, original_action_hash: &ActionHash, written_at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<Option<String>> {
    let Some(prev_action) = prev_action else { return Ok(Some("an order update can't open a chain".into())) };
    let Some(prior_version) = Version::at(original_action_hash)? else {
        return Err(wasm_error!(WasmErrorInner::Guest("original_action_hash does not point at a DeliveryOrder entry".into())));
    };
    let prior = &prior_version.order;
    let Some(required_author) = prior.status.transition_requirement(&order.status) else {
        return Ok(Some(format!("illegal status transition: {:?} -> {:?}", prior.status, order.status)));
    };
    let prior_bid = match &prior.accepted_bid {
        Some(bid_ref) => Some(decode::<Bid>(&must_get_valid_record(bid_ref.clone())?).ok_or(wasm_error!(WasmErrorInner::Guest("accepted_bid does not point at a Bid entry".into())))?),
        None => None,
    };
    let provider = prior_bid.as_ref().map(|bid| &bid.bidder);
    let is_provider = provider == Some(author);
    let is_requester = &prior.requester == author;
    let is_merchant = &prior.merchant == author;
    let authorized = match required_author {
        RequiredAuthor::Requester => is_requester,
        RequiredAuthor::Merchant => is_merchant,
        RequiredAuthor::RequesterOrMerchant => is_requester || is_merchant,
        RequiredAuthor::AcceptedProvider => is_provider,
        RequiredAuthor::RequesterOrProvider => is_requester || is_provider,
        RequiredAuthor::MerchantOrProvider => is_merchant || is_provider,
        RequiredAuthor::AnyParty => is_requester || is_merchant || is_provider,
    };
    if !authorized {
        return Ok(Some(format!(
            "transition {:?} -> {:?} requires author role {:?}, but the author holds none of the roles it permits",
            prior.status, order.status, required_author
        )));
    }
    let step = Step::of(&prior.status, &order.status, prior.accepted_bid.is_some());
    let order_original = resolve_original_creation(original_action_hash.clone())?;
    let update = OrderUpdate {
        requester: &prior.requester,
        merchant: &prior.merchant,
        author,
        prior_written_at: prior_version.written_at(),
        written_at,
    };

    // What's fixed when the store accepts the order: its check-in code, its
    // prep time.
    if let Some(reason) = sealed_fields_problem(order) {
        return Ok(Some(reason));
    }
    let accepted_terms_ok = if step.store_accepting {
        order.pickup_commitment.len() == 32 && order.sealed_pickup_code.is_some() && order.prep_minutes.is_some_and(|m| m > 0 && m <= handshake_governance::max_prep_minutes())
    } else {
        prior.pickup_commitment == order.pickup_commitment && prior.sealed_pickup_code == order.sealed_pickup_code && prior.prep_minutes == order.prep_minutes
    };
    if !accepted_terms_ok {
        return Ok(Some("the store sets its check-in code (32 bytes) and prep time, within the network's longest, when it accepts the order -- and never changes them".into()));
    }
    if step.store_accepting && !update.within_response_window() {
        return Ok(Some("the store's window to accept this order has passed".into()));
    }
    if let Some(reason) = check_cooking(&step, prior, order, written_at) {
        return Ok(Some(reason.into()));
    }
    let cancelled_from = (prior.status != DeliveryStatus::Cancelled && order.status == DeliveryStatus::Cancelled).then_some(match prior.status {
        DeliveryStatus::Placed => CancelledFrom::Placed,
        DeliveryStatus::Collecting => CancelledFrom::Collecting,
        DeliveryStatus::DriverAtStore => CancelledFrom::AtStore,
        DeliveryStatus::Open => CancelledFrom::Open,
        _ => CancelledFrom::Elsewhere,
    });
    if let Some(reason) = check_cancellation(&update, cancelled_from, &prior.cancellation, &order.cancellation) {
        return Ok(Some(reason));
    }

    // The driver: set when the customer accepts their bid, gone when they
    // leave, otherwise fixed. (Their copy of the address is a `DropoffShare`
    // of its own.)
    let driver_ok = if step.accepting {
        prior.accepted_bid.is_none() && order.accepted_bid.is_some()
    } else if step.releasing {
        order.accepted_bid.is_none()
    } else {
        prior.accepted_bid == order.accepted_bid
    };
    if !driver_ok {
        return Ok(Some("accepted_bid is set when a bid is accepted, cleared when its driver leaves, and otherwise never changes".into()));
    }

    // The money behind each step, set aside by whoever owes it and cited by
    // the step that needs it: the customer's food when the store accepts,
    // the driver's pay when the customer accepts a bid, the driver's
    // collateral when they commit, the store's when it checks them in. The
    // three for a driver go with them.
    let Some(terms) = terms_of(&order_original)? else { return Ok(Some("not an order".into())) };
    let bid_ref = if step.accepting { order.accepted_bid.clone() } else { prior.accepted_bid.clone() };
    let bid = match &bid_ref {
        Some(bid_ref) => decode::<Bid>(&must_get_valid_record(bid_ref.clone())?),
        None => None,
    };
    type HoldStep<'a> = (bool, bool, &'a Option<ActionHash>, &'a Option<ActionHash>, Option<HoldPurpose>, &'static str);
    let steps: [HoldStep; 4] = [
        (step.store_accepting, false, &prior.food_hold, &order.food_hold, Some(HoldPurpose::Food), "food_hold"),
        (step.accepting, true, &prior.driver_pay_hold, &order.driver_pay_hold, bid_ref.clone().map(|bid| HoldPurpose::DriverPay { bid }), "driver_pay_hold"),
        (step.committing, true, &prior.collateral_hold, &order.collateral_hold, bid_ref.clone().map(|bid| HoldPurpose::Collateral { bid }), "collateral_hold"),
        (step.checking_in, true, &prior.subsidy_hold, &order.subsidy_hold, bid_ref.clone().map(|bid| HoldPurpose::Subsidy { bid }), "subsidy_hold"),
    ];
    for (this_step, for_driver, before, after, purpose, field) in steps {
        if step.releasing && for_driver {
            if after.is_some() {
                return Ok(Some(format!("{field} goes with the driver it was for")));
            }
            continue;
        }
        if !this_step {
            if before != after {
                return Ok(Some(format!("{field} is set once, by the step it pays for")));
            }
            continue;
        }
        if before.is_some() {
            return Ok(Some(format!("{field} is already set")));
        }
        let Some(purpose) = purpose else { return Ok(Some("this step needs the order's accepted bid".into())) };
        let expected = ExpectedHold { order_original: &order_original, terms: &terms, purpose, bid: if for_driver { bid.as_ref() } else { None } };
        if let Err(reason) = check_hold(after, expected)? {
            return Ok(Some(reason));
        }
    }

    // An order changes drivers a bounded number of times: past it, it can
    // only be collected or cancelled.
    if step.accepting && !lineage::driver_changes(&prior_version)?.allow_another() {
        return Ok(Some("this order has changed drivers as many times as the network allows".into()));
    }

    // A scheduled order opens only once its time has come.
    if prior.status == DeliveryStatus::Scheduled && order.status == DeliveryStatus::Placed && written_at < prior.requested_delivery_time.unwrap_or(Timestamp(0)) {
        return Ok(Some("a scheduled order cannot open for bidding before its requested_delivery_time".into()));
    }

    // Proof of the time: a fresh round of the network's time source on
    // every update whose deadline costs someone else if it's claimed early --
    // a driver leaving (it dates the window another driver has, and proves a
    // store late), the store moving on a driver who's committed (who then
    // answers for the food), ending an order for want of a driver, or
    // keeping the food of a customer who never came. Every other update
    // carries the last one forward unchanged.
    let driver_leaving = step.releasing && is_provider;
    let store_moving_committed = step.releasing && is_merchant && prior.collateral_hold.is_some();
    let ending = |reason: Cancellation| order.cancellation == Some(reason) && cancelled_from.is_some();
    let needs_time = driver_leaving || store_moving_committed || ending(Cancellation::NoDriver) || ending(Cancellation::NotCollected);
    let proved_at = if needs_time {
        let Some(beacon) = order.beacon.as_ref().filter(|b| prior.beacon.as_ref() != Some(*b)) else {
            return Ok(Some("this step says when, with fresh proof of the time".into()));
        };
        match beacon::beacon_time(beacon) {
            Ok(at) => Some(at),
            Err(reason) => return Ok(Some(reason.into())),
        }
    } else {
        if order.beacon != prior.beacon {
            return Ok(Some("only a step whose deadline is proved sets its proof of the time".into()));
        }
        None
    };
    // A customer who chose to collect it and never came, past the window.
    if ending(Cancellation::NotCollected) {
        let window_ends = prior_version.written_at().as_micros().saturating_add(handshake_governance::collection_window().as_micros() as i64);
        if proved_at.is_none_or(|at| at.as_micros() < window_ends) {
            return Ok(Some("the store records an order uncollected only once the customer's window has passed".into()));
        }
    }

    // A driver's choices bind them across branches of the order's history
    // (see `dispatch_types::lineage`): one who's left it can't also pick it
    // up -- nor the other way round.
    if is_provider && (driver_leaving || step.picking_up) {
        let left = |v: &Version, p: &Version| v.released(p).is_some();
        let picked_up = |v: &Version, _: &Version| v.order.status == DeliveryStatus::PickedUp;
        let bound = if step.picking_up { lineage::wrote(author, prev_action, &order_original, left)? } else { lineage::wrote(author, prev_action, &order_original, picked_up)? };
        if bound {
            return Ok(Some("a driver either leaves an order or picks it up -- not both".into()));
        }
    }

    // The store moving a driver on: one who hasn't committed within the
    // offer window, or hasn't been checked in by when they were due -- and
    // never one it's checked in (its own chain says whether it has).
    let store_releasing = step.releasing && is_merchant;
    if store_releasing {
        let Some(bid_ref) = &prior.accepted_bid else { return Ok(Some("there's no driver to move on".into())) };
        let Some(bid) = &prior_bid else { return Ok(Some("there's no driver to move on".into())) };
        let due = match prior.status {
            DeliveryStatus::BidAccepted => prior_version.written_at().as_micros().saturating_add(handshake_governance::offer_window().as_micros() as i64),
            _ => match lineage::due_at_store(&prior_version, bid)? {
                Some(due) => due.as_micros(),
                None => return Ok(Some("this order has no ready time yet".into())),
            },
        };
        // A driver who's committed answers for the food once moved on, so
        // their lateness is proved; an offer they never took up is the
        // store's word.
        let now = proved_at.unwrap_or(written_at);
        if now.as_micros() < due {
            return Ok(Some("the store moves a driver on only once they've missed their offer or are late".into()));
        }
        let checked_in = |v: &Version, _: &Version| v.order.status == DeliveryStatus::DriverAtStore && v.order.accepted_bid.as_ref() == Some(bid_ref);
        if lineage::wrote(author, prev_action, &order_original, checked_in)? {
            return Ok(Some("a store can't move on a driver it's checked in".into()));
        }
    }
    // A customer can't cancel while a driver who left it cooking answers for
    // it -- the store would be paid for the food twice, by the customer and
    // by that driver. They wait for another driver (refunded in full if none
    // comes in time), or collect it.
    if order.status == DeliveryStatus::Cancelled && cancelled_from.is_some() && is_requester && lineage::liable_release(&prior_version)?.is_some() {
        return Ok(Some("a driver who left this order cooking answers for it until another takes it on or the window ends: wait, or collect it yourself".into()));
    }
    // Confirming a driver, or recording the customer collecting it: never
    // after ending the order for want of a driver -- the driver who answered
    // for the food would be cleared by this, and charged by that.
    if (step.cooking || (step.collecting && is_merchant)) && lineage::wrote(author, prev_action, &order_original, |v, p| v.order.cancellation == Some(Cancellation::NoDriver) && p.order.status != DeliveryStatus::Cancelled)? {
        return Ok(Some("a store that ended an order for want of a driver can't confirm another".into()));
    }
    // Checking a driver in: never one it's moved on.
    if step.checking_in {
        let bid_ref = prior.accepted_bid.clone();
        let moved_on = |v: &Version, p: &Version| v.released(p).is_some() && v.released(p) == bid_ref;
        if lineage::wrote(author, prev_action, &order_original, moved_on)? {
            return Ok(Some("a store can't check in a driver it's moved on".into()));
        }
    }

    // The customer collecting it: at their own request, recorded by the
    // store -- set by that update alone.
    let collect_request_ok = if step.collecting {
        match &order.collect_request {
            Some(request) => is_collect_request(request, &prior.requester, &order_original)?,
            None => false,
        }
    } else {
        prior.collect_request == order.collect_request
    };
    if !collect_request_ok {
        return Ok(Some("an order is collected by its customer at their own request, which the store's update cites".into()));
    }
    // Collected on the customer's word, or the store's scan of their code.
    let collection_proof_ok = if step.collected && is_merchant {
        order.collection_proof.as_ref().is_some_and(|code| code.opens(&prior.pin_commitment))
    } else if step.collected {
        order.collection_proof.is_none()
    } else {
        prior.collection_proof == order.collection_proof
    };
    if !collection_proof_ok {
        return Ok(Some("the store records an order collected with the customer's handover code".into()));
    }

    // The customer cancelling for free because the store kept a driver
    // waiting: only once a driver has called it late.
    if order.cancellation == Some(Cancellation::StoreLate) && cancelled_from.is_some() && !lineage::store_was_late(&prior_version)? {
        return Ok(Some("a customer cancels on the store's lateness only once a driver has called it late".into()));
    }
    // No driver came: see `no_driver_problem`.
    if order.cancellation == Some(Cancellation::NoDriver) && cancelled_from.is_some() {
        if let Some(reason) = no_driver_problem(&prior_version, author, prev_action, &order_original, proved_at.unwrap_or(Timestamp(0)))? {
            return Ok(Some(reason.into()));
        }
    }

    // The driver picks the order up on the store's record of handing it over.
    if step.picking_up {
        let Some(proof) = &order.pickup_proof else {
            return Ok(Some("picking an order up needs the store's record of handing it over".into()));
        };
        if let Err(reason) = validate_pickup_proof(&order_original, proof, &prior.merchant, author)? {
            return Ok(Some(reason.into()));
        }
    } else if prior.pickup_proof != order.pickup_proof {
        return Ok(Some("pickup_proof is set once, by the update picking the order up".into()));
    }
    // Delivered only on proof the customer has it, set once by the update
    // completing it -- final: there's no claim from Delivered.
    if step.completing {
        if !prior.delivery_receipts.is_empty() {
            return Ok(Some("delivery_receipts are set once, by the update completing the order".into()));
        }
        if let Err(reason) = validate_delivery_receipts(&order_original, &order.delivery_receipts)? {
            return Ok(Some(reason));
        }
    } else if prior.delivery_receipts != order.delivery_receipts {
        return Ok(Some("delivery_receipts are set once, by the update completing the order".into()));
    }
    // The customer's claim it never arrived. Their own decisions on another
    // branch of the order bind them: a customer who cancelled it (and so
    // owes the driver's fee) can't also claim it back.
    if step.claiming && wrote_update_of(author, prev_action, &order_original, |v| v.status == DeliveryStatus::Cancelled)? {
        return Ok(Some("a customer who cancelled an order can't claim it never arrived".into()));
    }

    let unchanged = prior.requester == order.requester
        && prior.merchant == order.merchant
        && prior.catalog_ref == order.catalog_ref
        && prior.catalog_version == order.catalog_version
        && prior.lines == order.lines
        && prior.loyalty_proof == order.loyalty_proof
        && prior.rewards == order.rewards
        && prior.order_total == order.order_total
        && prior.sealed_dropoff == order.sealed_dropoff
        && prior.kitchen_note == order.kitchen_note
        && prior.sealed_customer_name == order.sealed_customer_name
        && prior.sealed_wake == order.sealed_wake
        && prior.dropoff_geohash == order.dropoff_geohash
        && prior.max_delivery_fee == order.max_delivery_fee
        && prior.requested_at == order.requested_at
        && prior.tip_cents == order.tip_cents
        && prior.delivery_subsidy_percent == order.delivery_subsidy_percent
        && prior.requested_delivery_time == order.requested_delivery_time
        && prior.promo_code_ref == order.promo_code_ref
        && prior.dropoff_preference == order.dropoff_preference
        && prior.door_risk_accepted == order.door_risk_accepted
        && prior.priority == order.priority
        && prior.bag_claim_ref == order.bag_claim_ref
        && prior.pin_commitment == order.pin_commitment
        && prior.sealed_pin == order.sealed_pin
        && prior.auto_match == order.auto_match;
    if !unchanged {
        return Ok(Some("an order update may only change its status and what that step sets -- every other field must stay the same".into()));
    }
    Ok(None)
}

/// `ready_by` across one update: set when the store starts cooking -- for
/// the driver who's committed, or the customer coming for it -- no later
/// than the prep time it quoted from then, and never changed after. Cooking
/// that's already started (for an earlier driver) carries on.
fn check_cooking(step: &Step, prior: &DeliveryOrder, order: &DeliveryOrder, written_at: Timestamp) -> Option<&'static str> {
    if prior.ready_by.is_some() || !(step.cooking || step.collecting) {
        return (prior.ready_by != order.ready_by).then_some("ready_by is set once, when the store starts cooking");
    }
    let quoted = written_at.as_micros().saturating_add(i64::from(prior.prep_minutes.unwrap_or(0)) * 60 * 1_000_000);
    match order.ready_by {
        Some(ready_by) if ready_by >= written_at && ready_by.as_micros() <= quoted => None,
        _ => Some("starting to cook sets ready_by within the prep time the store quoted"),
    }
}

/// The store ending an order no driver came for: the version it ends is
/// open to bids, its driver answering for the food left (`released_liable`)
/// and no later driver confirmed -- past the network's window since they
/// left. The store's own chain shows it hasn't confirmed another, or
/// checked that one in, on another branch. `None` if it holds.
fn no_driver_problem(prior: &Version, store: &AgentPubKey, chain_top: &ActionHash, order_original: &ActionHash, proved_at: Timestamp) -> ExternResult<Option<&'static str>> {
    let Some((release, bid)) = lineage::liable_release(prior)? else {
        return Ok(Some("the store ends an order for want of a driver only after one left it cooking"));
    };
    let release_hash = release.record.action_address().clone();
    let Some(left_at) = lineage::release_time(&release, |b| beacon::beacon_time(b).ok())? else { return Ok(Some("that driver's leaving has no valid time")) };
    if proved_at.as_micros() < left_at.as_micros().saturating_add(handshake_governance::replacement_window().as_micros() as i64) {
        return Ok(Some("the store waits the network's window for another driver before ending the order"));
    }
    let confirmed_later = |v: &Version, p: &Version| Ok(lineage::confirms_driver(v, p) && v.order.accepted_bid.as_ref() != Some(&bid) && lineage::descends_from(v, &release_hash)?);
    if lineage::wrote_where(store, chain_top, order_original, confirmed_later)? {
        return Ok(Some("the store has confirmed another driver for this order"));
    }
    // A store that ended the order another way -- calling it off, or
    // recording the customer collecting it -- can't also end it on a
    // driver's account: each would settle that driver's collateral.
    let ended_otherwise = |v: &Version, p: &Version| (v.order.status == DeliveryStatus::Cancelled && p.order.status != DeliveryStatus::Cancelled) || (v.order.status == DeliveryStatus::Collecting && p.order.status != DeliveryStatus::Collecting);
    if lineage::wrote(store, chain_top, order_original, ended_otherwise)? {
        return Ok(Some("the store has already ended this order another way"));
    }
    // A driver the store checked in came for the food: whatever followed,
    // they never answer for it.
    let checked_in = |v: &Version, _: &Version| v.order.status == DeliveryStatus::DriverAtStore && v.order.accepted_bid.as_ref() == Some(&bid);
    if lineage::wrote(store, chain_top, order_original, checked_in)? {
        return Ok(Some("the store checked that driver in, so they don't answer for the food"));
    }
    Ok(None)
}

/// Whether `request` is `requester`'s request to collect `order`.
fn is_collect_request(request: &ActionHash, requester: &AgentPubKey, order: &ActionHash) -> ExternResult<bool> {
    let record = must_get_valid_record(request.clone())?;
    Ok(record.action().author() == requester && decode::<CollectRequest>(&record).is_some_and(|r| &r.order == order))
}

/// A customer asking to collect their delivery: theirs, for the order as
/// placed, once.
pub(crate) fn validate_collect_request(request: &CollectRequest, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(prev_action) = prev_action else { return Ok(ValidateCallbackResult::Invalid("a request can't open a chain".into())) };
    if resolve_original_creation(request.order.clone())? != request.order {
        return Ok(ValidateCallbackResult::Invalid("a request names its order by its original action".into()));
    }
    let Some(order) = decode::<DeliveryOrder>(&must_get_valid_record(request.order.clone())?) else {
        return Ok(ValidateCallbackResult::Invalid("a request to collect is for a delivery".into()));
    };
    if &order.requester != author {
        return Ok(ValidateCallbackResult::Invalid("only an order's customer asks to collect it".into()));
    }
    if lineage::asked_to_collect(author, prev_action, &request.order)? {
        return Ok(ValidateCallbackResult::Invalid("a customer asks to collect an order once".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// A customer sharing their address with a driver: theirs to share, with a
/// driver the order shows committed, and no larger than an address.
pub(crate) fn validate_dropoff_share(share: &DropoffShare, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if handshake_integrity_support::original_creation(share.order.clone())? != share.order || handshake_integrity_support::original_creation(share.committed.clone())? != share.order {
        return Ok(ValidateCallbackResult::Invalid("a share names an order by its original action, and one of its versions".into()));
    }
    let Some(order) = decode::<DeliveryOrder>(&must_get_valid_record(share.committed.clone())?) else {
        return Ok(ValidateCallbackResult::Invalid("a share is for a delivery".into()));
    };
    if &order.requester != author {
        return Ok(ValidateCallbackResult::Invalid("only an order's customer shares its address".into()));
    }
    let committed = match (&order.accepted_bid, order.collateral_hold.is_some()) {
        (Some(bid), true) => decode::<Bid>(&must_get_valid_record(bid.clone())?).is_some_and(|bid| bid.bidder == share.driver),
        _ => false,
    };
    if !committed {
        return Ok(ValidateCallbackResult::Invalid("the address is shared only with a driver the order shows committed".into()));
    }
    if let Some(problem) = sealed_problem("sealed", &share.sealed, MAX_SEALED_BYTES) {
        return Ok(ValidateCallbackResult::Invalid(problem));
    }
    Ok(ValidateCallbackResult::Valid)
}
