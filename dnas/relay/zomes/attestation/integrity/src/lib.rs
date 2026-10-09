//! Integrity zome for delivery handoffs. The driver records each handoff as
//! a `Leg` -- picking up from the store, handing over to the customer --
//! and the person on the other side acknowledges it with a
//! `ReceiptAttestation` of their own. Each is signed by its own author on
//! their own chain, and validation ties them together: a leg only by the
//! order's assigned driver, to that order's store or customer; a receipt
//! only by the leg's recipient. A delivery completes on the driver's
//! pickup record and the customer's receipt (see `dispatch_integrity`).

use dispatch_types::{Bid, DeliveryOrder};
use hdi::prelude::*;
use relay_integrity_support::{classify, decode, invalid, require, Checked};

mod links;

// Leg/LegKind/ReceiptAttestation now live in `attestation_types` so
// `dispatch_integrity` can decode them too, for its own completion-gate
// validation -- see that crate's doc comment for why a direct dependency on
// this crate wouldn't work. Re-exported here so nothing else in this crate
// or the coordinator crate (which imports via `attestation_integrity::*`)
// needs to change.
pub use attestation_types::{HandoffEvidence, Leg, LegKind, ReceiptAttestation};

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    Leg(Leg),
    ReceiptAttestation(ReceiptAttestation),
}

#[hdk_link_types]
pub enum LinkTypes {
    OrderToLeg,
    LegToReceipt,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match classify(op.flattened::<EntryTypes, LinkTypes>()?)? {
        Checked::Create { entry, action } => match entry {
            EntryTypes::Leg(leg) => validate_leg(&leg, action.author()),
            EntryTypes::ReceiptAttestation(receipt) => validate_receipt(&receipt, action.author()),
        },
        // Handoffs and their acknowledgments are a permanent record.
        Checked::Update { .. } => invalid("handoffs and receipts can't be changed"),
        Checked::Delete { .. } => invalid("handoffs and receipts can't be deleted"),
        Checked::CreateLink { link_type, action } => links::validate_create_link(link_type, &action.base_address, &action.target_address, action.author()),
        Checked::DeleteLink { .. } => links::validate_delete_link(),
        Checked::Other => Ok(ValidateCallbackResult::Valid),
    }
}

/// A handoff, recorded by the driver who made it: the order's assigned
/// driver, handing over to (or collecting from) that order's own store or
/// customer. `order_ref` is the version of the order the driver recorded
/// it against, which names them as its driver.
fn validate_leg(leg: &Leg, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    // Sealed, so its content can't be checked here (the parties' apps check
    // the photo when they open it) -- but its size can.
    if leg.sealed_evidence.as_encrypted_data_ref().len() > relay_integrity_support::MAX_IMAGE_URI_BYTES + 1_024 {
        return invalid("a handoff's evidence may hold at most one 300KB photo");
    }
    if author != &leg.from {
        return invalid("a handoff is recorded by the driver who made it");
    }
    let expected_sequence = match leg.kind {
        LegKind::MerchantHandoff => 0,
        LegKind::CustomerHandoff => 1,
    };
    if leg.sequence != expected_sequence {
        return invalid("a store handoff is leg 0 and a customer handoff leg 1");
    }
    let Some(order) = decode::<DeliveryOrder>(&must_get_valid_record(leg.order_ref.clone())?) else {
        return invalid("a handoff's order_ref must be a DeliveryOrder");
    };
    let Some(bid_ref) = &order.accepted_bid else { return invalid("a handoff needs the order's driver assigned") };
    let Some(bid) = decode::<Bid>(&must_get_valid_record(bid_ref.clone())?) else { return invalid("accepted_bid is not a Bid") };
    if bid.bidder != leg.from {
        return invalid("only the order's assigned driver records its handoffs");
    }
    let expected_counterparty = match leg.kind {
        LegKind::MerchantHandoff => &order.merchant,
        LegKind::CustomerHandoff => &order.requester,
    };
    require(&leg.to == expected_counterparty, "a handoff is with the order's own store or customer")
}

/// A handoff's acknowledgment, signed by the person who received it (or
/// handed it over, for the store).
fn validate_receipt(receipt: &ReceiptAttestation, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let Some(leg) = decode::<Leg>(&must_get_valid_record(receipt.leg.clone())?) else {
        return invalid("receipt.leg does not point at a Leg entry");
    };
    require(author == &leg.to, "a handoff is acknowledged by the other party to it")
}
