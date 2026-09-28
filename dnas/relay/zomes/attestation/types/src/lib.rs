//! `Leg` and `ReceiptAttestation` struct definitions, factored out of
//! `attestation_integrity` so `dispatch_integrity` can decode these entries
//! (via `must_get_valid_record`) during its own `validate()` -- see
//! `dispatch_integrity`'s completion-gate check. A plain dependency on the
//! `attestation_integrity` crate itself won't work: that crate's
//! `#[hdk_entry_types]`/`#[hdk_extern]` macros generate `#[no_mangle]`
//! wasm exports (`validate`, `entry_defs`, ...), and linking two crates
//! that each export a symbol named `validate` into the same wasm binary
//! fails at link time. This crate holds only the plain struct/enum defs --
//! no entry-type registration, no externs -- so it's safe for both
//! `attestation_integrity` (which registers these in its own `EntryTypes`)
//! and `dispatch_integrity` (which only ever reads them) to depend on.

use hdi::prelude::*;
use relay_types::GeoPoint;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum LegKind {
    MerchantHandoff,
    CustomerHandoff,
}

/// A single leg of a delivery's completion chain. A delivery is a 3-party
/// chain (merchant -> driver -> customer), so it always has exactly 2 legs
/// -- unlike a ride, which would need only 1 (driver <-> rider) if that
/// vertical is ever added. This is why completion isn't modeled as a single
/// dual-signature field on the order itself: it hides that asymmetry.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct Leg {
    pub order_ref: ActionHash,
    pub sequence: u8,
    pub kind: LegKind,
    pub from: AgentPubKey,
    pub to: AgentPubKey,
    pub geo_at_completion: GeoPoint,
    pub completed_at: Timestamp,
}

/// The dual-signed proof that a `Leg` actually happened. Intended to be
/// created via a native Holochain countersigning session between `leg.from`
/// and `leg.to`, not hand-rolled signature fields -- see the attestation
/// coordinator's `initiate_leg_attestation` for the session setup.
///
/// NOTE: fully verifying countersigning-session membership from inside a
/// deterministic `validate` callback is one of the trickier corners of the
/// HDK (session timeout/abandonment edge cases). The check in
/// `attestation_integrity::validate_receipt` is a best-effort placeholder
/// (author must be one of the leg's two parties) -- full session-membership
/// verification is flagged in the architecture plan as needing its own
/// isolated spike, not solved here. `dispatch_integrity`'s completion gate
/// (below, via this crate) checks that a `ReceiptAttestation` exists and is
/// well-formed for each required leg -- it does not re-verify countersigning
/// membership beyond what `attestation_integrity` already enforces.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct ReceiptAttestation {
    pub leg: ActionHash,
    pub attested_at: Timestamp,
}
