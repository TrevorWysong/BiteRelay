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
pub use dispute_types::{ArbitratorSeal, PinSecret};

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
    pub completed_at: Timestamp,
    /// Where the handoff happened, and (on `CustomerHandoff`, typically) a
    /// photo at the door -- a `HandoffEvidence`, sealed from `from` to
    /// `to`. A drop-off's location is the customer's door, so it's never
    /// published: only the two parties to the handoff can open it, and it
    /// reaches an arbitrator only if one of them shares it in a dispute.
    /// Evidence, not part of what completes a delivery: that's the other
    /// party's `ReceiptAttestation`.
    pub sealed_evidence: XSalsa20Poly1305EncryptedData,
    /// The PIN the customer gave the driver at the door, sealed to each
    /// arbitrator -- empty if none was collected. Required on a drop-off
    /// whose order says `pin_required`. Only an arbitrator can open it, to
    /// check against the PIN the customer committed to at checkout.
    #[serde(default)]
    pub sealed_pin_for_arbitrators: Vec<ArbitratorSeal>,
    /// The PIN and salt from the code the customer let the driver scan --
    /// checkable by anyone against the order's commitment, so a drop-off
    /// carrying them is proof the customer handed them over: their receipt.
    /// Revealed only at the door, once the food is there.
    #[serde(default)]
    pub revealed_pin: Option<PinSecret>,
}

/// A handoff's evidence (`HandoffEvidence`) shared with the arbitrators by
/// one of its two parties, for a dispute -- each seal opens to it for one
/// arbitrator. Nobody else can read it.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct EvidenceShare {
    pub leg: ActionHash,
    pub seals: Vec<ArbitratorSeal>,
}

/// What a handoff's sealed evidence holds.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HandoffEvidence {
    pub geo: GeoPoint,
    /// An inline image, or empty for none.
    pub photo_data_uri: String,
}

/// The other party to a `Leg` acknowledging it happened -- the store that
/// handed the order to the driver, or the customer it reached -- authored
/// on their own chain. Validation holds it to that party
/// (`attestation_integrity::validate_receipt`), so a driver can record a
/// handoff alone but can't acknowledge it for anyone. A delivery completes
/// on the driver's pickup `Leg` plus the customer's acknowledgment of the
/// drop-off (`dispatch_integrity`'s completion gate).
///
/// Two plain entries rather than one countersigned one: neither party has
/// to be online at the same moment as the other, the acknowledgment is a
/// deliberate act by the person (not something their conductor signs
/// automatically), and it runs on any Holochain build -- countersigning is
/// still behind an unstable feature that release runtimes don't ship.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct ReceiptAttestation {
    pub leg: ActionHash,
    pub attested_at: Timestamp,
}

/// Whether a delivery's receipts (`DeliveryOrder::delivery_receipts`) rest on
/// a drop-off against the customer's scanned handover code -- validation
/// checked the code against the order's commitment when the leg was
/// written. A scan is a receipt only this way, through the order version
/// that completes the delivery on it: a scan alone settles nothing, so a
/// ruling before that completion is the only thing that settles the order.
pub fn rests_on_scan(receipts: &[ActionHash]) -> ExternResult<bool> {
    for receipt in receipts {
        let record = must_get_valid_record(receipt.clone())?;
        if record.entry().to_app_option::<Leg>().ok().flatten().is_some_and(|leg| leg.kind == LegKind::CustomerHandoff && leg.revealed_pin.is_some()) {
            return Ok(true);
        }
    }
    Ok(false)
}
