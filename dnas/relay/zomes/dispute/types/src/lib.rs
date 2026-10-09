//! `Dispute` struct definitions, factored out of `dispute_integrity` so
//! `dispatch_integrity` can decode a `Dispute` (to check its resolution
//! before allowing a `Disputed -> Delivered`/`Cancelled` transition) without
//! linking in `dispute_integrity`'s own wasm exports -- same reasoning as
//! `attestation_types`/`dispatch_types`.

use hdi::prelude::*;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum DisputeReason {
    NeverDelivered,
    WrongOrIncompleteItems,
    ProviderAbandoned,
    /// The order is already `Cancelled` (a terminal state) and this dispute
    /// is *not* trying to change that -- it's adjudicating whether the
    /// cancellation was fair and who, if anyone, should be compensated from
    /// forfeited collateral (architecture plan §11.1). Raised via
    /// `dispatch::raise_cancellation_dispute`, resolved via
    /// `dispatch::apply_cancellation_dispute_resolution` -- both distinct
    /// from the `raise_dispute`/`apply_dispute_resolution` pair used for
    /// every other `DisputeReason`, since there's no order-status transition
    /// left to gate here, only a ledger forfeiture.
    UnjustCancellation,
    /// Raised by the driver when a delivery they've recorded handing over
    /// hasn't been confirmed by the customer within the network's window
    /// (`relay_governance::confirm_window`) -- with their sealed evidence
    /// shared to the arbitrators. Unanswered, it's the provider's.
    NotConfirmed,
    Other,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum DisputeStatus {
    Open,
    Resolved,
}

/// No `Dismissed`/no-fault outcome -- every dispute resolves to a definitive
/// `Delivered` or `Cancelled` (see `DeliveryOrder::dispute_ref`'s doc
/// comment). A dispute raised in error is `FavorProvider`.
///
/// A ruling moves no money itself: it's the evidence each party's held
/// money is settled by (see `ledger_integrity`). For the provider, the
/// order is paid as if delivered and the driver's collateral returned; for
/// the customer, their holds come back to them and the driver's collateral
/// goes to the store, which handed over the food.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum DisputeOutcome {
    FavorProvider,
    FavorRequester,
}

/// A dispute case, either over whether a delivery was actually completed
/// properly (raised from `DeliveryOrder`'s `PickedUp`/`Delivered` statuses,
/// resolved to a terminal `Delivered`/`Cancelled` -- architecture plan §8)
/// or, for `DisputeReason::UnjustCancellation`, over whether an *already*
/// `Cancelled` order's cancellation was fair and who owes compensation
/// (§11.1 -- the order's status never changes for this kind, there's
/// nothing left to transition). Resolved unilaterally by a single listed
/// arbitrator (`relay_governance`) either way -- a deliberate, named
/// centralization point, not a decentralized jury.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct Dispute {
    pub order_ref: ActionHash,
    pub raised_by: AgentPubKey,
    pub respondent: AgentPubKey,
    pub reason: DisputeReason,
    pub description: String,
    pub evidence_refs: Vec<ActionHash>,
    pub status: DisputeStatus,
    pub outcome: Option<DisputeOutcome>,
    pub arbitrator: Option<AgentPubKey>,
    pub reasoning: Option<String>,
    pub raised_at: Timestamp,
    pub resolved_at: Option<Timestamp>,
}

/// A secret sealed to one arbitrator on the DNA's roster -- evidence only
/// arbitrators can open: a delivery PIN, a photo at the door.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ArbitratorSeal {
    pub arbitrator: AgentPubKey,
    pub sealed: XSalsa20Poly1305EncryptedData,
}

/// A delivery's PIN, as the customer seals it at checkout -- to
/// themselves, to show at the door, and to the arbitrators, to check a
/// driver's word against. The order publishes only a commitment to it
/// (`sha256(pin || salt)`); without `salt`, which only the customer and
/// the arbitrators hold, nobody can test PINs against that commitment.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PinSecret {
    pub pin: String,
    pub salt: Vec<u8>,
}

/// Whether `seals` is exactly one seal for each arbitrator on `roster`
/// (their keys as strings, as `relay_governance` holds them).
pub fn seals_cover_roster(seals: &[ArbitratorSeal], roster: &[String]) -> bool {
    seals.len() == roster.len() && roster.iter().all(|key| seals.iter().filter(|s| &s.arbitrator.to_string() == key).count() == 1)
}
