//! The two dispatch-side halves of the dispute/arbitration subsystem
//! (architecture plan §8): raising a dispute against an order in `PickedUp`
//! or `Delivered`, and -- once an arbitrator has ruled, via `dispute`'s own
//! `submit_resolution` -- applying that ruling's consequences (payment,
//! forfeiture, reputation) and flipping the order to its terminal status.
//!
//! Both cross-zome-call into `dispute` (for the case entry itself) and
//! `ledger`/`reputation` (reusing the exact same functions
//! `complete_delivery` already uses -- `ledger::release_on_completion` and
//! the previously-unused `ledger::forfeit`, plus reputation event kinds
//! that were speculatively designed in the original architecture pass and
//! never wired up until now).

use crate::order_queues::{self, OrderParties};
use crate::orders::{record_reputation_event, ReputationEventKindWire, ReputationTargetWire};
use crate::settlement::{self, Payer};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::resolve_latest_decoded;

/// Derives who the *other* party to a dispute is -- whichever side of the
/// order didn't raise it -- along with the reputation target that party
/// answers as (a delivery dispute is always customer vs. driver). Shared by
/// `raise_dispute` and `raise_cancellation_dispute`, which otherwise
/// duplicated this exact branching with only the final error message's
/// wording differing.
fn derive_respondent(order: &DeliveryOrder, bid: &Bid, me: &AgentPubKey, unauthorized_reason: &str) -> ExternResult<(AgentPubKey, ReputationTargetWire)> {
    if me == &bid.bidder {
        Ok((order.requester.clone(), ReputationTargetWire::Customer(order.requester.clone())))
    } else if me == &order.requester || me == &order.merchant {
        Ok((bid.bidder.clone(), ReputationTargetWire::Driver(bid.bidder.clone())))
    } else {
        Err(wasm_error!(WasmErrorInner::Guest(unauthorized_reason.into())))
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub enum DisputeReasonWire {
    NeverDelivered,
    WrongOrIncompleteItems,
    ProviderAbandoned,
    UnjustCancellation,
    Other,
}

#[derive(Serialize, Deserialize, Debug)]
struct OpenDisputeInputWire {
    order_ref: ActionHash,
    respondent: AgentPubKey,
    reason: DisputeReasonWire,
    description: String,
    evidence_refs: Vec<ActionHash>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RaiseDisputeInput {
    pub order_original_action: ActionHash,
    pub reason: DisputeReasonWire,
    pub description: String,
    pub evidence_refs: Vec<ActionHash>,
}

/// Derives `respondent` from the order's actual parties rather than trusting
/// client input -- whichever side didn't raise the dispute. Cross-zome-calls
/// `dispute::open_dispute` first (executes in this same agent's context, so
/// its own `raised_by` and this update's author agree), records a
/// `DisputeRaised` reputation event against the respondent (informational,
/// not punitive -- only losing the ruling is), then updates the order to
/// `Disputed` + `dispute_ref`.
#[hdk_extern]
pub fn raise_dispute(input: RaiseDisputeInput) -> ExternResult<Record> {
    let (order_record, order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_original_action.clone(), "DeliveryOrder")?;

    let me = agent_info()?.agent_initial_pubkey;
    let accepted_bid_ref = order
        .accepted_bid
        .clone()
        .ok_or(wasm_error!(WasmErrorInner::Guest("order has no accepted bid to dispute".into())))?;
    let (_, bid): (_, Bid) = resolve_latest_decoded(accepted_bid_ref, "Bid")?;

    let (respondent, respondent_target) = derive_respondent(
        &order,
        &bid,
        &me,
        "only the order's requester, merchant, or accepted provider may raise a dispute",
    )?;

    let open_response = call(
        CallTargetCell::Local,
        "dispute",
        "open_dispute".into(),
        None,
        OpenDisputeInputWire {
            order_ref: input.order_original_action.clone(),
            respondent: respondent.clone(),
            reason: input.reason,
            description: input.description,
            evidence_refs: input.evidence_refs,
        },
    )?;
    let ZomeCallResponse::Ok(extern_io) = open_response else {
        return Err(wasm_error!(WasmErrorInner::Guest("dispute::open_dispute cross-zome call failed".into())));
    };
    let dispute_record: Record = extern_io.decode().map_err(|e| wasm_error!(e))?;
    let dispute_ref = dispute_record.action_address().clone();

    // Best-effort, informational -- see doc comment above.
    record_reputation_event(&respondent, respondent_target, input.order_original_action.clone(), ReputationEventKindWire::DisputeRaised)?;

    let mut updated_order = order;
    updated_order.status = DeliveryStatus::Disputed;
    updated_order.dispute_ref = Some(dispute_ref);
    let updated = update_entry(order_record.action_address().clone(), &EntryTypes::DeliveryOrder(updated_order))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back disputed order".into())))
}

// Reading back `dispute::get_dispute`'s entry uses the real `dispute_types`
// crate directly (not a hand-rolled wire mirror like the call-*input*
// mirrors above): decoding an entry via `to_app_option` requires the
// `TryFrom<SerializedBytes>` impl `#[hdk_entry_helper]` generates, which
// `dispute_types::Dispute` already has, correctly wired up in that crate's
// own Cargo.toml -- reusing it here is simpler than re-deriving the same
// machinery on a mirror struct. This is safe (no wasm-export collision risk)
// because `dispute_types` has zero `#[hdk_extern]`s, unlike `dispute_integrity`.
use dispute_types::{Dispute, DisputeOutcome};

#[derive(Serialize, Deserialize, Debug)]
pub struct ApplyDisputeResolutionInput {
    pub order_original_action: ActionHash,
}

/// Called by the arbitrator after `dispute::submit_resolution`. Reads the
/// now-resolved outcome, applies its consequences, then updates the order to
/// the matching terminal status -- validated per `dispatch_integrity`'s
/// `validate_dispute_resolution_matches`, so this coordinator's own
/// bookkeeping is a fast-fail convenience, not the actual enforcement, same
/// posture as `complete_delivery` post-fix.
#[hdk_extern]
pub fn apply_dispute_resolution(input: ApplyDisputeResolutionInput) -> ExternResult<Record> {
    // Explicit, synchronous gate -- deliberately checked here rather than
    // left to dispatch_integrity's validate() alone. update_entry does not
    // validate synchronously: it stages the write, and self-validation only
    // runs when this whole extern call returns and Holochain commits every
    // staged write together. Code written *after* update_entry in this
    // function (the ledger/reputation `call()`s below) still executes even
    // when that eventual commit will be rejected -- and those nested calls
    // are separate, independent zome invocations that commit immediately,
    // for real, regardless of what the outer commit later decides. So an
    // unauthorized caller whose own update_entry is destined to fail can
    // still leak real reputation events (and, if they happen to be a party
    // to the ledger transaction, real payments) before that failure is ever
    // discovered. Found by testing the cancellation-dispute sibling
    // (apply_cancellation_dispute_resolution) against a real non-arbitrator
    // caller -- this function has the identical shape and the identical
    // exposure, just never exercised by a test that used a real
    // unauthorized caller instead of the isolated bypass extern.
    if !relay_governance::is_arbitrator(&agent_info()?.agent_initial_pubkey)? {
        return Err(wasm_error!(WasmErrorInner::Guest("only an arbitrator may apply a dispute resolution".into())));
    }
    let (order_record, order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_original_action.clone(), "DeliveryOrder")?;
    if order.status != DeliveryStatus::Disputed {
        return Err(wasm_error!(WasmErrorInner::Guest("an order can only have its dispute resolution applied from Disputed".into())));
    }
    let dispute_ref = order
        .dispute_ref
        .clone()
        .ok_or(wasm_error!(WasmErrorInner::Guest("order has no dispute_ref".into())))?;
    let accepted_bid_ref = order
        .accepted_bid
        .clone()
        .ok_or(wasm_error!(WasmErrorInner::Guest("order has no accepted bid".into())))?;
    let (_, bid): (_, Bid) = resolve_latest_decoded(accepted_bid_ref, "Bid")?;

    let get_response = call(CallTargetCell::Local, "dispute", "get_dispute".into(), None, dispute_ref)?;
    let ZomeCallResponse::Ok(extern_io) = get_response else {
        return Err(wasm_error!(WasmErrorInner::Guest("dispute::get_dispute cross-zome call failed".into())));
    };
    let dispute_record: Record = extern_io.decode().map_err(|e| wasm_error!(e))?;
    let dispute: Dispute = dispute_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a Dispute".into())))?;
    let outcome = dispute
        .outcome
        .ok_or(wasm_error!(WasmErrorInner::Guest("dispute has no outcome yet -- call dispute::submit_resolution first".into())))?;

    let requester = order.requester.clone();
    let target_status = match &outcome {
        DisputeOutcome::FavorProvider { .. } => DeliveryStatus::Delivered,
        DisputeOutcome::FavorRequester { .. } => DeliveryStatus::Cancelled,
    };
    let parties = OrderParties::delivery(&input.order_original_action, &order)?;
    let mut updated_order = order;
    updated_order.cancellation = (target_status == DeliveryStatus::Cancelled).then_some(Cancellation::ByArbitrator);
    updated_order.status = target_status;
    // Advance dispute_ref to the dispute's resolved version: validation reads
    // it literally (`must_get_valid_record`), so it must point straight at
    // the Resolved content -- which `dispute::get_dispute` returned.
    updated_order.dispute_ref = Some(dispute_record.action_address().clone());
    let owed = delivery_payments(&updated_order, &bid);
    // The driver's collateral, posted at pickup -- the customer's to keep
    // if the ruling goes their way.
    let collateral_held = if updated_order.collateral_hold.is_some() { bid.collateral } else { 0 };
    let updated = update_entry(order_record.action_address().clone(), &EntryTypes::DeliveryOrder(updated_order))?;
    // Both outcomes (Delivered / Cancelled) are terminal.
    order_queues::retire(&parties)?;
    let dispute_basis = dispute_record.action_address();

    match outcome {
        DisputeOutcome::FavorProvider { forfeit_amount } => {
            // The ruling confirms the delivery happened, so the order is
            // settled in full -- every leg, the driver's collateral back
            // included, by the arbitrator.
            settlement::pay_legs(&input.order_original_action, &updated, &owed, Payer::Arbitrator)?;
            settlement::forfeit(&input.order_original_action, dispute_basis, &requester, &bid.bidder, forfeit_amount)?;
            record_reputation_event(&requester, ReputationTargetWire::Customer(requester.clone()), input.order_original_action.clone(), ReputationEventKindWire::DisputeResolvedAgainst)?;
        }
        // The customer keeps the collateral the driver posted at pickup:
        // that's the forfeit, and all the driver stood to lose, so nothing
        // more moves (validation refuses it).
        DisputeOutcome::FavorRequester { .. } => {
            record_reputation_event(&bid.bidder, ReputationTargetWire::Driver(bid.bidder.clone()), input.order_original_action.clone(), ReputationEventKindWire::DisputeResolvedAgainst)?;
            if collateral_held > 0 {
                record_reputation_event(
                    &bid.bidder,
                    ReputationTargetWire::Driver(bid.bidder.clone()),
                    input.order_original_action.clone(),
                    ReputationEventKindWire::CollateralForfeited { amount: collateral_held },
                )?;
            }
        }
    }

    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back resolved order".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RaiseCancellationDisputeInput {
    pub order_original_action: ActionHash,
    pub description: String,
    pub evidence_refs: Vec<ActionHash>,
}

/// Cancellation-fairness disputes (architecture plan §11.1) -- unlike
/// `raise_dispute`, this requires the order to *already* be `Cancelled`
/// (not `PickedUp`/`Delivered`) and never moves it to `Disputed`: the order
/// is already terminal, there's no status left to change, only
/// compensation to adjudicate. Sets `dispute_ref` via the same-status
/// `Cancelled -> Cancelled` "transition" `dispatch_integrity` allows
/// specifically for this case, reusing the exact same `validate_new_dispute_ref`
/// check `raise_dispute` relies on.
#[hdk_extern]
pub fn raise_cancellation_dispute(input: RaiseCancellationDisputeInput) -> ExternResult<Record> {
    let (order_record, order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_original_action.clone(), "DeliveryOrder")?;
    if order.status != DeliveryStatus::Cancelled {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "a cancellation-fairness dispute can only be raised against an already-Cancelled order".into()
        )));
    }

    let me = agent_info()?.agent_initial_pubkey;
    let accepted_bid_ref = order
        .accepted_bid
        .clone()
        .ok_or(wasm_error!(WasmErrorInner::Guest("an order that never had an accepted bid cannot have a cancellation-fairness dispute -- there was no provider to be unfair to".into())))?;
    let (_, bid): (_, Bid) = resolve_latest_decoded(accepted_bid_ref, "Bid")?;

    let (respondent, respondent_target) = derive_respondent(
        &order,
        &bid,
        &me,
        "only the order's requester, merchant, or accepted provider may raise a cancellation-fairness dispute",
    )?;

    let open_response = call(
        CallTargetCell::Local,
        "dispute",
        "open_dispute".into(),
        None,
        OpenDisputeInputWire {
            order_ref: input.order_original_action.clone(),
            respondent: respondent.clone(),
            reason: DisputeReasonWire::UnjustCancellation,
            description: input.description,
            evidence_refs: input.evidence_refs,
        },
    )?;
    let ZomeCallResponse::Ok(extern_io) = open_response else {
        return Err(wasm_error!(WasmErrorInner::Guest("dispute::open_dispute cross-zome call failed".into())));
    };
    let dispute_record: Record = extern_io.decode().map_err(|e| wasm_error!(e))?;
    let dispute_ref = dispute_record.action_address().clone();

    record_reputation_event(&respondent, respondent_target, input.order_original_action.clone(), ReputationEventKindWire::DisputeRaised)?;

    let mut updated_order = order;
    // status is deliberately left as Cancelled -- only dispute_ref changes.
    updated_order.dispute_ref = Some(dispute_ref);
    let updated = update_entry(order_record.action_address().clone(), &EntryTypes::DeliveryOrder(updated_order))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back order with cancellation dispute raised".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ApplyCancellationDisputeResolutionInput {
    pub order_original_action: ActionHash,
}

/// Applies a cancellation-fairness ruling's consequences. Unlike
/// `apply_dispute_resolution`, the order's *status* never changes (already
/// correctly `Cancelled`, no status left to change) -- but `dispute_ref`
/// still advances from the dispute's creation hash to its resolved-update
/// hash, exactly as the original design does for `Disputed ->
/// Delivered`/`Cancelled`. That advance is what closes a real replay gap:
/// without it, nothing in `dispatch_integrity::validate()` would ever run
/// for this call (no status change to gate), and the winning party --
/// legitimately "a party" to the resulting ledger transaction, so
/// `ledger_integrity`'s own check alone wouldn't catch it -- could call
/// this repeatedly to multiply the forfeiture. `update_entry` is
/// deliberately attempted *before* the ledger calls: if validation rejects
/// the advance for any reason, nothing gets paid out. Nothing is paid for
/// the order itself either way -- a cancelled order was never delivered --
/// only collateral moves, as compensation for the unfairness.
#[hdk_extern]
pub fn apply_cancellation_dispute_resolution(input: ApplyCancellationDisputeResolutionInput) -> ExternResult<()> {
    // See the identical comment in apply_dispute_resolution above: update_entry's
    // own validation is deferred to commit time (when this whole extern
    // returns), so it cannot be relied on to stop the ledger/reputation
    // `call()`s below from executing and committing for real. Both the
    // authorization check and the already-applied check below must run
    // here, synchronously, before anything side-effecting.
    if !relay_governance::is_arbitrator(&agent_info()?.agent_initial_pubkey)? {
        return Err(wasm_error!(WasmErrorInner::Guest("only an arbitrator may apply a cancellation-dispute resolution".into())));
    }
    let (order_record, order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_original_action.clone(), "DeliveryOrder")?;
    if order.status != DeliveryStatus::Cancelled {
        return Err(wasm_error!(WasmErrorInner::Guest("a cancellation dispute resolution can only be applied to a Cancelled order".into())));
    }
    let dispute_ref = order
        .dispute_ref
        .clone()
        .ok_or(wasm_error!(WasmErrorInner::Guest("order has no dispute_ref".into())))?;
    let accepted_bid_ref = order
        .accepted_bid
        .clone()
        .ok_or(wasm_error!(WasmErrorInner::Guest("order has no accepted bid".into())))?;
    let (_, bid): (_, Bid) = resolve_latest_decoded(accepted_bid_ref, "Bid")?;

    let get_response = call(CallTargetCell::Local, "dispute", "get_dispute".into(), None, dispute_ref)?;
    let ZomeCallResponse::Ok(extern_io) = get_response else {
        return Err(wasm_error!(WasmErrorInner::Guest("dispute::get_dispute cross-zome call failed".into())));
    };
    let dispute_record: Record = extern_io.decode().map_err(|e| wasm_error!(e))?;
    let dispute: Dispute = dispute_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a Dispute".into())))?;
    let outcome = dispute
        .outcome
        .ok_or(wasm_error!(WasmErrorInner::Guest("dispute has no outcome yet -- call dispute::submit_resolution first".into())))?;

    // Explicit, synchronous replay check -- order.status never changes for a
    // cancellation-fairness dispute (it was already Cancelled and stays
    // that way), so unlike apply_dispute_resolution's own top-of-function
    // status check, there's no natural "already applied" signal to read
    // from order.status on a fresh call. dispute_ref is that signal
    // instead: it starts out pointing at the dispute's original creation
    // hash (set by raise_cancellation_dispute) and only ever advances to
    // the resolved hash via a successful call to this function. If it
    // already equals the resolved hash, this has already been applied.
    if order.dispute_ref.as_ref() == Some(dispute_record.action_address()) {
        return Err(wasm_error!(WasmErrorInner::Guest("this cancellation-dispute resolution has already been applied".into())));
    }

    let requester = order.requester.clone();
    let mut updated_order = order;
    updated_order.dispute_ref = Some(dispute_record.action_address().clone());
    update_entry(order_record.action_address().clone(), &EntryTypes::DeliveryOrder(updated_order))?;

    match outcome {
        // The cancellation was unfair to the provider: the requester
        // compensates them, same forfeit-only shape as the FavorRequester
        // branch below just with from/to swapped.
        DisputeOutcome::FavorProvider { forfeit_amount } => {
            settlement::forfeit(&input.order_original_action, dispute_record.action_address(), &requester, &bid.bidder, forfeit_amount)?;
            // The requester lost this ruling (the cancellation was found
            // unfair to the provider) -- DisputeResolvedAgainst belongs on
            // them, not on the provider who just won. Mirrors
            // apply_dispute_resolution's own FavorProvider branch, which
            // correctly records this against `requester`.
            record_reputation_event(&requester, ReputationTargetWire::Customer(requester.clone()), input.order_original_action.clone(), ReputationEventKindWire::DisputeResolvedAgainst)?;
        }
        // The cancellation was fine (or the provider themselves caused it):
        // the provider compensates the requester, if anything is owed.
        DisputeOutcome::FavorRequester { forfeit_amount } => {
            settlement::forfeit(&input.order_original_action, dispute_record.action_address(), &bid.bidder, &requester, forfeit_amount)?;
            // Unconditional -- the provider lost this ruling regardless of
            // whether any amount was actually forfeited (mirrors
            // apply_dispute_resolution's identical FavorRequester shape).
            record_reputation_event(&bid.bidder, ReputationTargetWire::Driver(bid.bidder.clone()), input.order_original_action.clone(), ReputationEventKindWire::DisputeResolvedAgainst)?;
            if forfeit_amount > 0 {
                record_reputation_event(
                    &bid.bidder,
                    ReputationTargetWire::Driver(bid.bidder.clone()),
                    input.order_original_action.clone(),
                    ReputationEventKindWire::CollateralForfeited { amount: forfeit_amount },
                )?;
            }
        }
    }

    Ok(())
}
