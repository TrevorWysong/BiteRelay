//! `DeliveryOrder`/`Bid` struct definitions, factored out of `dispatch_integrity`
//! so `dispute_integrity` can decode a `DeliveryOrder` (to check who its real
//! parties are before accepting a dispute) without linking in
//! `dispatch_integrity`'s own wasm exports -- same reasoning as
//! `attestation_types`: two integrity zomes both exporting a symbol named
//! `validate` into the same wasm binary fails to link.

use hdi::prelude::*;
use relay_types::{GeoPoint, LedgerCommitmentRef};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum DeliveryStatus {
    Open,
    BidAccepted,
    MerchantConfirmed,
    DriverEnRouteToMerchant,
    PickedUp,
    Delivered,
    Cancelled,
    Disputed,
}

/// Who is allowed to *author* a given transition -- deliberately a separate
/// axis from whether the transition is topologically legal
/// (`transition_requirement` below encodes both together specifically so
/// they can't drift apart into two tables that disagree). Early on, any of
/// "requester, merchant, or accepted provider" was accepted for *every*
/// transition once a provider existed -- which meant a provider could
/// unilaterally cancel an order they never should have been able to touch,
/// or jump straight to MerchantConfirmed. Real money makes that worth
/// closing properly rather than leaving it broad.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequiredAuthor {
    /// The requester or the order's merchant (may be the same agent).
    RequesterOrMerchant,
    /// Specifically the agent behind `accepted_bid`, once one exists.
    AcceptedProvider,
    /// Any of the three -- used only for raising a dispute, where whoever
    /// noticed the problem should be able to flag it.
    Any,
    /// An agent on the DNA's arbitrator roster (`relay_governance::is_arbitrator`)
    /// -- used only for resolving a dispute back to a terminal status. See
    /// architecture plan §8 for why this is a deliberate, named
    /// centralization point rather than a decentralized jury.
    Arbitrator,
}

impl DeliveryStatus {
    /// The order lifecycle's allowed forward transitions *and* who is
    /// allowed to author each one. `None` means the transition is illegal
    /// regardless of author. Encoded once here so a validation fix for one
    /// step can't accidentally loosen another -- see the plan's note on why
    /// rides/delivery need separate state machines rather than one enum
    /// stretched to cover both verticals.
    pub fn transition_requirement(&self, next: &DeliveryStatus) -> Option<RequiredAuthor> {
        use DeliveryStatus::*;
        use RequiredAuthor::*;
        match (self, next) {
            // accept_bid and cancellation before pickup: the customer/merchant side.
            (Open, BidAccepted) => Some(RequesterOrMerchant),
            (Open, Cancelled) => Some(RequesterOrMerchant),
            (BidAccepted, MerchantConfirmed) => Some(RequesterOrMerchant),
            (BidAccepted, Cancelled) => Some(RequesterOrMerchant),
            (MerchantConfirmed, Cancelled) => Some(RequesterOrMerchant),
            (DriverEnRouteToMerchant, Cancelled) => Some(RequesterOrMerchant),
            // Once accepted, the provider reports their own physical progress.
            (MerchantConfirmed, DriverEnRouteToMerchant) => Some(AcceptedProvider),
            (DriverEnRouteToMerchant, PickedUp) => Some(AcceptedProvider),
            // complete_delivery (dispatch coordinator) is always called by
            // the requester confirming receipt -- not reachable via the
            // generic set_order_status path at all (that's blocked at the
            // coordinator), but still validated here since validation must
            // hold regardless of which coordinator function got here.
            (PickedUp, Delivered) => Some(RequesterOrMerchant),
            // Disputes: whoever notices the problem should be able to raise one.
            (PickedUp, Disputed) => Some(Any),
            (Delivered, Disputed) => Some(Any),
            // Resolution: only a listed arbitrator, and only via
            // dispatch::apply_dispute_resolution -- see architecture plan §8.
            // The outcome/target polarity match (FavorProvider <-> Delivered,
            // FavorRequester <-> Cancelled) is checked separately in
            // dispatch_integrity's validate_order_transition, since that
            // requires cross-referencing the Dispute entry itself, not just
            // the author's role.
            (Disputed, Delivered) => Some(Arbitrator),
            (Disputed, Cancelled) => Some(Arbitrator),
            // Cancellation-fairness disputes (architecture plan §11.1): a
            // same-status "transition" whose only effect is populating
            // dispute_ref -- the order is already correctly Cancelled (a
            // terminal state) and stays that way; there's no status left to
            // decide between, only compensation to adjudicate. Whoever
            // notices the unfairness (either side) can raise one, same as
            // the PickedUp/Delivered dispute-raising transitions above.
            (Cancelled, Cancelled) => Some(Any),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum BidStatus {
    Open,
    Accepted,
    Withdrawn,
    Expired,
    Rejected,
}

/// One concrete entry type per vertical (this one, plus a future
/// `RideRequest` if rides are ever added) rather than one generalized "Job"
/// with a cargo-type enum: cramming both into one entry would force a
/// single `validate_order_transition` to branch across genuinely different
/// rule sets, and force one status enum to carry variants meaningless to
/// the other vertical. `Bid` stays generic below, since bidding really is
/// symmetric across verticals.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct DeliveryOrder {
    pub requester: AgentPubKey,
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    pub item_refs: Vec<ActionHash>,
    pub order_total: u64,
    pub dropoff: GeoPoint,
    pub dropoff_geohash: String,
    pub max_delivery_fee: Option<u64>,
    pub status: DeliveryStatus,
    pub accepted_bid: Option<ActionHash>,
    /// Empty until the `PickedUp -> Delivered` transition, at which point it
    /// must reference a `ReceiptAttestation` for every required leg kind
    /// (`MerchantHandoff`, `CustomerHandoff`) belonging to this exact order.
    /// This used to be a coordinator-level trust check only
    /// (`dispatch::complete_delivery` cross-zome-called `attestation` and
    /// trusted its own count) -- nothing stopped a peer from calling
    /// `update_entry` directly to skip it. Putting the references on the
    /// entry itself lets `validate_order_transition` independently re-derive
    /// and check them via `must_get_valid_record`, which is deterministic
    /// (content-addressed, already-validated history) unlike a `get_links`
    /// query would be -- so this is now enforced network-wide, not just for
    /// honest callers of `complete_delivery`.
    pub delivery_receipts: Vec<ActionHash>,
    /// Empty until a dispute is raised (`PickedUp`/`Delivered -> Disputed`),
    /// at which point it references the one `Dispute` entry (`dispute`
    /// zome) covering this order -- set once, then immutable, same pattern
    /// as `accepted_bid` and `delivery_receipts`. See architecture plan §8.
    pub dispute_ref: Option<ActionHash>,
    pub requested_at: Timestamp,
    /// Set once at request_delivery time, immutable thereafter -- same
    /// treatment as order_total/dropoff/etc below. `#[serde(default)]` so
    /// existing orders (and any client that hasn't caught up) still decode.
    #[serde(default)]
    pub special_instructions: String,
    #[serde(default)]
    pub tip_cents: u64,
}

#[hdk_entry_helper]
#[derive(Clone)]
pub struct Bid {
    pub order_ref: ActionHash,
    pub bidder: AgentPubKey,
    pub eta_seconds: u32,
    pub price_offer: u64,
    pub collateral_commitment: LedgerCommitmentRef,
    pub status: BidStatus,
    pub created_at: Timestamp,
}
