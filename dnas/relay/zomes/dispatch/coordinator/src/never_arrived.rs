//! A delivery that never arrived: the customer says so, and the store
//! decides (`issues::decide_order`). Until it has, a driver running late
//! can still complete the delivery with proof the customer has it.

use crate::orders::{record_reputation_event, ReputationEventKindWire, ReputationTargetWire};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{guest, resolve_latest_decoded, resolve_version_decoded, update_version, written};

/// The customer saying their delivery never arrived -- once the driver has
/// picked it up and before it's delivered. Recorded against the driver
/// (informational: only the store's decision counts against them).
#[hdk_extern]
pub fn claim_never_arrived(order_original_action: ActionHash) -> ExternResult<Record> {
    let (current, mut order): (_, DeliveryOrder) = resolve_version_decoded(order_original_action.clone(), "DeliveryOrder")?;
    if order.requester != agent_info()?.agent_initial_pubkey {
        return Err(guest("Only the order's customer can say it never arrived."));
    }
    if order.status != DeliveryStatus::PickedUp {
        return Err(guest("You can say an order never arrived once your driver has picked it up, and until it's delivered."));
    }
    let bid_ref = order.accepted_bid.clone().ok_or(guest("This order has no driver yet."))?;
    let (_, bid): (_, Bid) = resolve_latest_decoded(bid_ref, "Bid")?;
    order.status = DeliveryStatus::Disputed;
    let updated = update_version(&current, &EntryTypes::DeliveryOrder(order), LinkTypes::Version)?;
    record_reputation_event(&bid.bidder, ReputationTargetWire::Driver(bid.bidder.clone()), order_original_action, ReputationEventKindWire::DisputeRaised, updated.clone())?;
    written(updated)
}

