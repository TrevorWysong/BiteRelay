//! Coordinator zome for delivery handoffs: the driver records each handoff
//! (`record_leg`) and the person on the other side acknowledges it
//! (`acknowledge_leg`) -- two entries, each signed by its own author on
//! their own chain, tied together by validation (see the integrity crate).
//! Neither party needs the other online at the same moment.
//!
//! `pickup_proof_for_order` and `delivery_proof_for_order` are what
//! dispatch cites to pick an order up and to complete it.

use hdk::prelude::*;

mod legs;

pub use legs::*;

/// A giver checks a typed handoff code on their own conductor, called by the
/// driver (`legs::confirm_by_code`), and a store checks a driver's check-in
/// code (`legs::confirm_check_in`) -- anyone may ask; each answers only the
/// order's own driver, and only the right code, within a few tries, counts.
#[hdk_extern]
pub fn init() -> ExternResult<InitCallbackResult> {
    prepare_device(())?;
    Ok(InitCallbackResult::Pass)
}

/// See `dispatch_coordinator::signals::prepare_device`.
#[hdk_extern]
pub fn prepare_device(_: ()) -> ExternResult<()> {
    relay_coordinator_support::ensure_open_calls("codes", &["confirm_by_code", "confirm_check_in"])?;
    Ok(())
}

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
