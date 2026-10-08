//! Link validation. `complete_delivery`'s gate (and its integrity re-check
//! in dispatch) finds an order's handoffs by walking these links, so each
//! must really belong where it's linked: a leg under its own order, a
//! receipt under the leg it attests.

use crate::*;
use relay_integrity_support::{decode, invalid, link_target, require, LinkTarget};

pub fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let LinkTarget::Record(record) = link_target(target)? else {
        return invalid("attestation links must target a record");
    };
    match link_type {
        LinkTypes::OrderToLeg => {
            let Some(leg) = decode::<Leg>(&record) else { return invalid("target is not a Leg") };
            require(
                author == record.action().author() && base == &AnyLinkableHash::from(leg.order_ref),
                "a leg may only be linked under its own order, by its author",
            )
        }
        LinkTypes::LegToReceipt => {
            let Some(receipt) = decode::<ReceiptAttestation>(&record) else { return invalid("target is not a ReceiptAttestation") };
            let leg_author = must_get_valid_record(receipt.leg.clone())?.action().author().clone();
            require(
                base == &AnyLinkableHash::from(receipt.leg) && author == &leg_author,
                "a receipt may only be linked under the leg it attests, by that leg's author",
            )
        }
    }
}

/// Handoff evidence is permanent.
pub fn validate_delete_link() -> ExternResult<ValidateCallbackResult> {
    invalid("attestation links can't be deleted")
}
