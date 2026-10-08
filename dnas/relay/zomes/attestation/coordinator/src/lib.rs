//! Coordinator zome for delivery-completion proof: a `Leg` records a
//! handoff unilaterally, and `initiate_leg_attestation` turns it into a
//! dual-signed `ReceiptAttestation` via native Holochain countersigning.
//!
//! - `countersigning` -- the capability grant, the preflight exchange, and
//!   the dual commit (see its doc comments on why sessions are
//!   non-enzymatic).
//! - `legs` -- the plain `Leg` entry, the leg->receipt link, and every
//!   read-side query -- including `count_attested_legs_for_order`, which is
//!   what `dispatch::complete_delivery` actually depends on.

mod countersigning;
mod legs;

pub use countersigning::*;
pub use legs::*;

#[cfg(feature = "test-utils")]
mod test_utils {
    use hdk::prelude::*;
    use attestation_integrity::LinkTypes;
    relay_coordinator_support::raw_link_test_externs!(OrderToLeg, LegToReceipt);
}
