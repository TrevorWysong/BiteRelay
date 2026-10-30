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
pub use handshake_types::PinSecret;
use handshake_types::GeoPoint;
use handshake_integrity_support::SealedChunks;

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
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct Leg {
    pub order_ref: ActionHash,
    pub sequence: u8,
    pub kind: LegKind,
    pub from: AgentPubKey,
    pub to: AgentPubKey,
    pub completed_at: Timestamp,
    /// Where the handoff happened, and a photo -- a `HandoffEvidence`,
    /// sealed from `from` to `to`. A drop-off's location is the customer's
    /// door, so it's never published: only the two parties to the handoff
    /// can open it.
    pub sealed_evidence: SealedChunks,
    /// The giver's handoff code, as the driver scanned it -- the store's at
    /// pickup, the customer's at the door. Checkable by anyone against the
    /// order's commitment, so a handoff carrying it is proof the giver
    /// handed the order over.
    #[serde(default)]
    pub revealed_pin: Option<PinSecret>,
    /// A drop-off left at the door, on an order whose customer chose that
    /// and accepted the risk: the delivery is complete once it's recorded.
    #[serde(default)]
    pub left_at_door: bool,
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
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct ReceiptAttestation {
    pub leg: ActionHash,
    pub attested_at: Timestamp,
}

/// What a delivery's drop-off rests on: the driver's `CustomerHandoff` leg
/// in its receipts (`DeliveryOrder::delivery_receipts`), and the proof the
/// customer has the order -- `None` if there's none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropoffProof {
    /// The customer let the driver scan their code.
    Scanned,
    /// The customer confirmed it themselves (`ReceiptAttestation`).
    Confirmed,
    /// Left at the door, as the customer chose.
    LeftAtDoor,
}

/// The proof among `receipts` that the order reached its customer, with
/// the drop-off leg it's about. Validation of each receipt checked it
/// against its order (the scanned code against the commitment; a receipt
/// against its author); this only classifies them.
pub fn dropoff_proof(receipts: &[ActionHash]) -> ExternResult<Option<DropoffProof>> {
    for receipt in receipts {
        let record = must_get_valid_record(receipt.clone())?;
        if let Some(leg) = record.entry().to_app_option::<Leg>().ok().flatten().filter(|leg| leg.kind == LegKind::CustomerHandoff) {
            if leg.revealed_pin.is_some() {
                return Ok(Some(DropoffProof::Scanned));
            }
            if leg.left_at_door {
                return Ok(Some(DropoffProof::LeftAtDoor));
            }
        }
        if let Some(attestation) = record.entry().to_app_option::<ReceiptAttestation>().ok().flatten() {
            let leg = must_get_valid_record(attestation.leg)?;
            if leg.entry().to_app_option::<Leg>().ok().flatten().is_some_and(|leg| leg.kind == LegKind::CustomerHandoff) {
                return Ok(Some(DropoffProof::Confirmed));
            }
        }
    }
    Ok(None)
}
