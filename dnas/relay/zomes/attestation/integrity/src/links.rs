//! Link validation. `complete_delivery`'s gate (and its integrity re-check
//! in dispatch) finds an order's handoffs by walking these links, so each
//! must really belong where it's linked: a leg under its own order, a
//! receipt under the leg it attests.

use crate::*;
use relay_integrity_support::{decode, invalid, linked_record, original_creation, require};

pub fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let Some(record) = linked_record(target)? else {
        return invalid("attestation links must target a record");
    };
    match link_type {
        // Validated as a version (`validate`).
        LinkTypes::Version => invalid("a version link is validated as one"),
        LinkTypes::OrderToLeg => {
            let Some(leg) = decode::<Leg>(&record) else { return invalid("target is not a Leg") };
            require(
                author == record.action().author() && base == &AnyLinkableHash::from(original_creation(leg.order_ref)?),
                "a leg may only be linked under its own order, by its author",
            )
        }
        LinkTypes::LegToReceipt => {
            let Some(receipt) = decode::<ReceiptAttestation>(&record) else { return invalid("target is not a ReceiptAttestation") };
            require(
                base == &AnyLinkableHash::from(receipt.leg) && author == record.action().author(),
                "a receipt may only be linked under the leg it acknowledges, by its author",
            )
        }
    }
}

/// Handoff evidence is permanent.
pub fn validate_delete_link() -> ExternResult<ValidateCallbackResult> {
    invalid("attestation links can't be deleted")
}
