//! Coordinator zome for delivery handoffs: the driver records each handoff
//! (`record_leg`) and the person on the other side acknowledges it
//! (`acknowledge_leg`) -- two entries, each signed by its own author on
//! their own chain, tied together by validation (see the integrity crate).
//! Neither party needs the other online at the same moment.
//!
//! `delivery_proof_for_order` is what `dispatch::complete_delivery` uses to
//! gather the proof a delivery needs before it can complete.

mod legs;

pub use legs::*;

#[cfg(feature = "test-utils")]
mod test_utils {
    use attestation_integrity::{EntryTypes, Leg, LinkTypes, ReceiptAttestation};
    use hdk::prelude::*;
    relay_coordinator_support::raw_link_test_externs!(OrderToLeg, LegToReceipt);

    /// Writes a `Leg` exactly as given -- what a modified client could --
    /// so a test can prove validation refuses a forged handoff.
    #[hdk_extern]
    pub fn create_raw_leg_for_testing(leg: Leg) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::Leg(leg))
    }

    /// The same, for a forged acknowledgment.
    #[hdk_extern]
    pub fn create_raw_receipt_for_testing(receipt: ReceiptAttestation) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::ReceiptAttestation(receipt))
    }
}
