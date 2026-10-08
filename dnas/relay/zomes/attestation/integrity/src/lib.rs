//! Integrity zome for delivery-completion proof: `Leg` (a unilateral handoff
//! claim) and `ReceiptAttestation` (the dual-signed proof, committed via
//! native countersigning -- see the coordinator crate's `countersigning`
//! module). A delivery is a 3-party chain, so it always has 2 legs.

use hdi::prelude::*;

mod links;

// Leg/LegKind/ReceiptAttestation now live in `attestation_types` so
// `dispatch_integrity` can decode them too, for its own completion-gate
// validation -- see that crate's doc comment for why a direct dependency on
// this crate wouldn't work. Re-exported here so nothing else in this crate
// or the coordinator crate (which imports via `attestation_integrity::*`)
// needs to change.
pub use attestation_types::{Leg, LegKind, ReceiptAttestation};

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
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::Leg(leg) => validate_leg(&leg, action.author()),
            EntryTypes::ReceiptAttestation(receipt) => validate_receipt(&receipt, action.author()),
        },
        FlatOp::Link(OpLink::CreateLink { link_type, action }) => links::validate_create_link(link_type, &action.base_address, &action.target_address, action.author()),
        FlatOp::Link(OpLink::DeleteLink { .. }) => links::validate_delete_link(),
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_leg(leg: &Leg, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if leg.from == leg.to {
        return Ok(ValidateCallbackResult::Invalid("a leg's from and to must be different agents".into()));
    }
    if author != &leg.from && author != &leg.to {
        return Ok(ValidateCallbackResult::Invalid(
            "a leg can only be authored by one of its own two parties".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_receipt(receipt: &ReceiptAttestation, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let leg_record = must_get_valid_record(receipt.leg.clone())?;
    // `to_app_option::<Leg>()` returns `Err`, not `Ok(None)`, for an entry
    // that's genuinely a different type -- collapsing both cases into the
    // same clean Invalid this already intends, rather than letting a
    // decode error propagate as an opaque SerializedBytesError instead.
    let leg: Leg = match leg_record.entry().to_app_option::<Leg>() {
        Ok(Some(l)) => l,
        _ => return Ok(ValidateCallbackResult::Invalid("receipt.leg does not point at a Leg entry".into())),
    };
    if author != &leg.from && author != &leg.to {
        return Ok(ValidateCallbackResult::Invalid(
            "a receipt can only be authored by one of its leg's two parties".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}
