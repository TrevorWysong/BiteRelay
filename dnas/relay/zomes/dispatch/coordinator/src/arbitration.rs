//! What happens to a delivery the customer doesn't confirm, and the clear
//! cases an arbitrator's conductor rules on its own.
//!
//! When the driver records a drop-off, the customer is told at once and has
//! the network's window (`relay_governance::confirm_window`, shorter when
//! the PIN was collected) to confirm it or report a problem. Their payment
//! stays held either way -- not confirming gains them nothing.
//!
//! After the window, the driver's conductor raises the delivery as
//! `NotConfirmed`, sharing its sealed evidence with the arbitrators
//! (`escalate_unconfirmed`). An arbitrator's conductor then rules the clear
//! cases (`arbitrate`):
//!
//! - the driver collected the customer's PIN, and it matches -- or what the
//!   customer sealed at checkout doesn't match their own commitment: for the
//!   provider;
//! - an unconfirmed delivery (`NotConfirmed`) the customer never disputed,
//!   with the driver's photo on record: for the provider.
//!
//! Anything else -- a customer's "never arrived" with no PIN to answer it,
//! a mismatched PIN -- waits for a person, with the evidence and the
//! customer's history in front of them.

use crate::disputes::{apply_dispute_resolution, raise_dispute, ApplyDisputeResolutionInput, DisputeReasonWire, RaiseDisputeInput};
use crate::pin::{verdict, PinVerdict};
use attestation_types::{HandoffEvidence, Leg, LegKind};
use dispatch_integrity::*;
use dispute_types::{Dispute, DisputeOutcome, DisputeReason, DisputeStatus};
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, resolve_latest, resolve_latest_decoded};

fn attestation<I: Serialize + std::fmt::Debug, O: serde::de::DeserializeOwned + std::fmt::Debug>(function: &str, input: I) -> ExternResult<O> {
    match call(CallTargetCell::Local, "attestation", function.into(), None, input)? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e)),
        other => Err(wasm_error!(WasmErrorInner::Guest(format!("{function}: {other:?}")))),
    }
}

/// The driver's drop-off on an order, if they've recorded one.
fn dropoff(order: &ActionHash) -> ExternResult<Option<(Record, Leg)>> {
    let legs: Vec<Record> = attestation("get_legs_for_order", order.clone())?;
    Ok(legs.into_iter().filter_map(|r| decode_or::<Leg>(&r).map(|l| (r, l))).find(|(_, l)| l.kind == LegKind::CustomerHandoff))
}

/// Raises each of the caller's (a driver's) deliveries the customer hasn't
/// confirmed within the window; returns how many. Safe to call any time.
#[hdk_extern]
pub fn escalate_unconfirmed(_: ()) -> ExternResult<u32> {
    let me = agent_info()?.agent_initial_pubkey;
    let now = sys_time()?;
    let mut raised = 0;
    for delivery in crate::order_queues::get_my_active_deliveries(())? {
        let order_ref = delivery.order.original_action.clone();
        let Some(order) = decode_or::<DeliveryOrder>(&delivery.order.record) else { continue };
        if order.status != DeliveryStatus::PickedUp || order.dispute_ref.is_some() {
            continue;
        }
        let Some((leg_record, leg)) = dropoff(&order_ref)? else { continue };
        if leg.from != me {
            continue;
        }
        let window = if leg.sealed_pin_for_arbitrators.is_empty() { relay_governance::confirm_window() } else { relay_governance::pin_confirm_window() };
        let due = leg_record.action().timestamp().as_micros() + window.as_micros() as i64;
        if now.as_micros() < due {
            continue;
        }
        let share: ActionHash = attestation("share_handoff_evidence", leg_record.action_address().clone())?;
        let raise = raise_dispute(RaiseDisputeInput {
            order_original_action: order_ref,
            reason: DisputeReasonWire::NotConfirmed,
            description: "Delivered, and not confirmed within the window.".into(),
            evidence_refs: vec![leg_record.action_address().clone(), share],
        });
        if raise.is_ok() {
            raised += 1;
        }
    }
    Ok(raised)
}

#[derive(Serialize, Debug)]
struct ListOpenDisputesWire {
    after: Option<Timestamp>,
}

#[derive(Deserialize, Debug)]
struct OpenDisputesPageWire {
    disputes: Vec<Record>,
    next_after: Option<Timestamp>,
}

#[derive(Serialize, Debug)]
struct SubmitResolutionWire {
    dispute_original_action: ActionHash,
    outcome: DisputeOutcome,
    reasoning: String,
}

fn dispute_zome<I: Serialize + std::fmt::Debug, O: serde::de::DeserializeOwned + std::fmt::Debug>(function: &str, input: I) -> ExternResult<O> {
    match call(CallTargetCell::Local, "dispute", function.into(), None, input)? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e)),
        other => Err(wasm_error!(WasmErrorInner::Guest(format!("{function}: {other:?}")))),
    }
}

/// The ruling a clear case gets, and why -- `None` for one a person must
/// decide.
fn clear_ruling(dispute: &Dispute, order: &DeliveryOrder) -> ExternResult<Option<(DisputeOutcome, String)>> {
    match verdict(&dispute.order_ref)? {
        PinVerdict::Matches => return Ok(Some((DisputeOutcome::FavorProvider, "The driver collected the customer's delivery PIN at the door.".into()))),
        PinVerdict::CustomerTampered => return Ok(Some((DisputeOutcome::FavorProvider, "The PIN the customer sealed at checkout doesn't match the one they committed to.".into()))),
        PinVerdict::Mismatch | PinVerdict::NotCollected => {}
    }
    if dispute.reason != DisputeReason::NotConfirmed {
        return Ok(None);
    }
    let Some(bid_ref) = &order.accepted_bid else { return Ok(None) };
    let (_, bid): (_, Bid) = resolve_latest_decoded(bid_ref.clone(), "Bid")?;
    let Some((leg_record, _)) = dropoff(&dispute.order_ref)? else { return Ok(None) };
    let evidence: Option<HandoffEvidence> = attestation("get_shared_evidence", leg_record.action_address().clone())?;
    let photographed = evidence.is_some_and(|e| !e.photo_data_uri.is_empty());
    Ok((dispute.raised_by == bid.bidder && photographed).then(|| (DisputeOutcome::FavorProvider, "Not confirmed or disputed within the window; the driver's photo of the drop-off is on record.".into())))
}

/// Rules every clear case among the open disputes; returns how many. Does
/// nothing unless the caller is an arbitrator.
#[hdk_extern]
pub fn arbitrate(_: ()) -> ExternResult<u32> {
    if !relay_governance::is_arbitrator(&agent_info()?.agent_initial_pubkey)? {
        return Ok(0);
    }
    let mut ruled = 0;
    let mut after = None;
    loop {
        let page: OpenDisputesPageWire = dispute_zome("list_open_disputes", ListOpenDisputesWire { after })?;
        for record in &page.disputes {
            let Some(dispute) = decode_or::<Dispute>(record) else { continue };
            if dispute.status != DisputeStatus::Open {
                continue;
            }
            let Ok(order_record) = resolve_latest(dispute.order_ref.clone()) else { continue };
            let Some(order) = decode_or::<DeliveryOrder>(&order_record) else { continue };
            if order.status != DeliveryStatus::Disputed {
                continue;
            }
            let Ok(Some((outcome, reasoning))) = clear_ruling(&dispute, &order) else { continue };
            let original = relay_coordinator_support::original_action_of(record.action_address().clone())?;
            let submitted: ExternResult<Record> = dispute_zome("submit_resolution", SubmitResolutionWire { dispute_original_action: original, outcome, reasoning });
            if submitted.is_ok() && apply_dispute_resolution(ApplyDisputeResolutionInput { order_original_action: dispute.order_ref.clone() }).is_ok() {
                ruled += 1;
            }
        }
        match page.next_after {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    Ok(ruled)
}

/// Every five minutes, for as long as the conductor runs: drivers raise
/// what's gone unconfirmed, arbitrators rule what's clear. Scheduled at
/// `init`; each half does nothing for an agent it doesn't apply to.
#[hdk_extern(infallible)]
pub fn review_disputes_periodically(_: Option<Schedule>) -> Option<Schedule> {
    let _ = escalate_unconfirmed(());
    let _ = arbitrate(());
    Some(Schedule::Persisted("0 */5 * * * * *".into()))
}
