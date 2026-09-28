//! Coordinator zome for delivery-completion proof: a `Leg` records a
//! handoff unilaterally, and `initiate_leg_attestation` turns it into a
//! dual-signed `ReceiptAttestation` via native Holochain countersigning.
//!
//! - `countersigning` -- the capability grant, the preflight exchange, and
//!   the dual commit. This is the "isolated spike" the architecture plan
//!   called for; see its doc comments for the real bug found and fixed
//!   while proving it out (enzymatic vs. non-enzymatic sessions).
//! - `legs` -- the plain `Leg` entry, the leg->receipt link, and every
//!   read-side query -- including `count_attested_legs_for_order`, which is
//!   what `dispatch::complete_delivery` actually depends on.

mod countersigning;
mod legs;

pub use countersigning::*;
pub use legs::*;
