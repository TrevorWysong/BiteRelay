//! A delivery that never arrived: the customer says so, and the store
//! decides (`issues::decide_order`). Until it has, a driver running late
//! can still complete the delivery with proof the customer has it.

use crate::orders::{record_reputation_event, ReputationEventKindWire, ReputationTargetWire};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::resolve_latest_decoded;

/// The customer saying their delivery never arrived -- once the driver has
/// picked it up and before it's delivered. Recorded against the driver
/// (informational: only the store's decision counts against them).
#[hdk_extern]
pub fn claim_never_arrived(order_original_action: ActionHash) -> ExternResult<Record> {
    let (record, mut order): (_, DeliveryOrder) = resolve_latest_decoded(order_original_action.clone(), "DeliveryOrder")?;
    if order.requester != agent_info()?.agent_initial_pubkey {
        return Err(guest("only the order's customer can say it never arrived"));
    }
    if order.status != DeliveryStatus::PickedUp {
        return Err(guest("You can say an order never arrived once your driver has picked it up, and until it's delivered."));
    }
    let bid_ref = order.accepted_bid.clone().ok_or(guest("this order has no driver"))?;
    let (_, bid): (_, Bid) = resolve_latest_decoded(bid_ref, "Bid")?;
    order.status = DeliveryStatus::Disputed;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;
    record_reputation_event(&bid.bidder, ReputationTargetWire::Driver(bid.bidder.clone()), order_original_action, ReputationEventKindWire::DisputeRaised, updated.clone())?;
    get(updated, GetOptions::local())?.ok_or(guest("could not read back the order"))
}

fn guest(message: &str) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message.into()))
}
