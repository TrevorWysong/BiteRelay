//! `DeliveryOrder`/`Bid` struct definitions, factored out of `dispatch_integrity`
//! so `dispute_integrity` can decode a `DeliveryOrder` (to check who its real
//! parties are before accepting a dispute) without linking in
//! `dispatch_integrity`'s own wasm exports -- same reasoning as
//! `attestation_types`: two integrity zomes both exporting a symbol named
//! `validate` into the same wasm binary fails to link.

use hdi::prelude::*;
use relay_types::{GeoPoint, LedgerCommitmentRef};

mod settlement;
pub use settlement::*;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum DeliveryStatus {
    /// A future-dated order that hasn't started matching yet -- see
    /// `DeliveryOrder.requested_delivery_time`. Never reachable via
    /// `set_order_status`'s generic path; only `request_delivery` (create)
    /// and `open_scheduled_order` (the one narrow transition out of it)
    /// touch this status.
    Scheduled,
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
    /// Finished from the store's point of view -- it leaves the store's
    /// active queue (see `dispatch_integrity::store_queue`).
    pub fn is_terminal(&self) -> bool {
        matches!(self, DeliveryStatus::Delivered | DeliveryStatus::Cancelled)
    }

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
            // A scheduled order becoming live -- only via
            // `dispatch::open_scheduled_order`, which additionally checks
            // `sys_time() >= requested_delivery_time` (a time constraint,
            // not an authorship one, so it lives in `validate_order_transition`
            // alongside the other per-transition field checks, not here).
            (Scheduled, Open) => Some(RequesterOrMerchant),
            (Scheduled, Cancelled) => Some(RequesterOrMerchant),
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

/// How the customer wants the driver to handle the actual drop-off --
/// closed enum (not a free-text field) so a driver's UI can show a fixed,
/// unambiguous instruction rather than parsing arbitrary text. Separate
/// from `special_instructions` (still free text, for anything else, e.g.
/// a gate code) -- this field is specifically the one DoorDash-style
/// choice drivers act on differently (knock-and-wait vs. leave-and-go).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DropoffPreference {
    #[default]
    LeaveAtDoor,
    HandToMe,
    MeetOutside,
}

/// Where a delivery goes, in full -- only ever stored sealed (see
/// `DeliveryOrder::sealed_dropoff`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct DropoffDetails {
    pub point: GeoPoint,
    /// Drop-off instructions for the driver ("gate code 1234").
    pub notes: String,
}

/// One line of an order: an item, the exact version of it that was priced
/// (the item as the customer saw it -- validation reads its price from
/// there), and how many.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct OrderLine {
    /// The item's identity (its original action). For a goodie-bag order,
    /// the bag.
    pub item_ref: ActionHash,
    /// The version priced: `item_ref` itself or one of its updates.
    pub priced_version: ActionHash,
    pub quantity: u32,
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
    /// What was ordered, each line priced at a specific version of its item
    /// -- validation recomputes `order_total` from these.
    pub lines: Vec<OrderLine>,
    pub order_total: u64,
    /// The drop-off's area (a geohash cell, about 1.2 x 0.6 km) -- all that's
    /// public about where the order goes: enough for drivers nearby to find
    /// it and judge the trip. The exact point is in `sealed_dropoff`.
    pub dropoff_geohash: String,
    /// The exact drop-off and the customer's drop-off notes
    /// (`DropoffDetails`), sealed to the customer themselves.
    pub sealed_dropoff: XSalsa20Poly1305EncryptedData,
    /// The same details sealed to the driver -- set when the customer accepts
    /// their bid, so only the driver doing the delivery ever learns the exact
    /// address.
    pub driver_dropoff: Option<XSalsa20Poly1305EncryptedData>,
    /// The customer's note for the kitchen, sealed to the store. `None` when
    /// there isn't one.
    pub kitchen_note: Option<XSalsa20Poly1305EncryptedData>,
    pub max_delivery_fee: Option<u64>,
    pub status: DeliveryStatus,
    pub accepted_bid: Option<ActionHash>,
    /// Empty until the `PickedUp -> Delivered` transition, at which point it
    /// must reference a `ReceiptAttestation` for every required leg kind
    /// (`MerchantHandoff`, `CustomerHandoff`) belonging to this exact order.
    /// Carrying the references on the entry is what lets validation check
    /// them deterministically (`must_get_valid_record`, unlike a link query),
    /// so the gate holds for every peer, not just honest callers of
    /// `complete_delivery`.
    pub delivery_receipts: Vec<ActionHash>,
    /// Empty until a dispute is raised (`PickedUp`/`Delivered -> Disputed`),
    /// at which point it references the one `Dispute` entry (`dispute`
    /// zome) covering this order -- set once, then immutable, same pattern
    /// as `accepted_bid` and `delivery_receipts`. See architecture plan §8.
    pub dispute_ref: Option<ActionHash>,
    pub requested_at: Timestamp,
    #[serde(default)]
    pub tip_cents: u64,
    /// The store's share of the delivery fee, in percent -- the split in
    /// force when the order was placed (the store's `delivery_subsidy_percent`
    /// then), fixed for this order. The store accepts it by confirming the
    /// order; settlement and ledger validation both read it from here.
    pub delivery_subsidy_percent: u8,
    /// `None` means "order now," the original and still-default behavior.
    /// `Some(t)` means this order was created in `Scheduled` status instead
    /// of `Open` -- matching never begins until the requester's own client
    /// calls `open_scheduled_order` at/after this time (see
    /// `validate_order_transition`'s `(Scheduled, Open)` arm). There's no
    /// p2p cron here, deliberately: this app already relies on clients
    /// polling/acting on their own schedule everywhere else (presence
    /// beacons, the matching backstop), so a scheduled order becoming live
    /// via the same pattern is consistent, not a new kind of dependency.
    #[serde(default)]
    pub requested_delivery_time: Option<Timestamp>,
    /// `None` means no promo code was applied. `Some` references a real
    /// `PromoCode` entry (`catalog_types`) that `validate_new_order`
    /// independently checks belongs to this same `catalog_ref`, is
    /// `active`, and isn't expired -- see that function's own doc comment
    /// for what this does and doesn't verify (the code's *validity* is
    /// checked deterministically; the discount's arithmetic effect on
    /// `order_total` is not independently re-derived, same trust tier
    /// `order_total` itself already has).
    #[serde(default)]
    pub promo_code_ref: Option<ActionHash>,
    /// Set once at request_delivery time, immutable thereafter, same
    /// treatment as the other per-order fields above. Defaults to
    /// `LeaveAtDoor` on decode for orders written before this field existed.
    #[serde(default)]
    pub dropoff_preference: DropoffPreference,
    /// `None` for an ordinary menu order (the default, and every order
    /// written before this field existed). `Some` means this delivery
    /// originated from a confirmed `catalog::BagClaim` (a goodie bag
    /// claimed for delivery rather than pickup) -- `validate_new_order`
    /// independently checks the referenced claim is genuinely `Confirmed`
    /// and names this same `requester` as its customer, same trust tier
    /// and same cross-crate-without-cross-zome-wasm-link pattern already
    /// used for `promo_code_ref`/`PromoCode` above.
    #[serde(default)]
    pub bag_claim_ref: Option<ActionHash>,
    /// For a loyalty promo ("your 6th order here is 15% off"): the
    /// customer's own completions of earlier orders at this store, which
    /// validation counts. Empty otherwise.
    #[serde(default)]
    pub loyalty_proof: Vec<ActionHash>,
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

/// `PickupOrder`'s own, much smaller lifecycle -- see `DeliveryOrder`'s own
/// doc comment for why this is a separate entry type (and separate status
/// enum) rather than a flag on `DeliveryOrder`: there is no bid, no driver,
/// no leg attestation here at all, just the requester and the merchant.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum PickupStatus {
    Placed,
    MerchantConfirmed,
    ReadyForPickup,
    PickedUp,
    Cancelled,
    Disputed,
}

impl PickupStatus {
    /// See `DeliveryStatus::is_terminal`.
    pub fn is_terminal(&self) -> bool {
        matches!(self, PickupStatus::PickedUp | PickupStatus::Cancelled)
    }

    /// `DeliveryStatus::transition_requirement`'s sibling, kept as its own
    /// function rather than squeezed into that one -- same "rides/delivery
    /// need separate state machines" reasoning `DeliveryOrder`'s doc comment
    /// already states, now applied to pickup as the second such vertical.
    pub fn transition_requirement(&self, next: &PickupStatus) -> Option<RequiredAuthor> {
        use PickupStatus::*;
        use RequiredAuthor::*;
        match (self, next) {
            // The merchant acknowledging + prepping the order -- the only
            // two parties here are the requester and the merchant, so both
            // are trusted for the customer-side cancellation path, same as
            // DeliveryOrder's pre-pickup cancellation arms.
            (Placed, MerchantConfirmed) => Some(RequesterOrMerchant),
            (Placed, Cancelled) => Some(RequesterOrMerchant),
            (MerchantConfirmed, Cancelled) => Some(RequesterOrMerchant),
            // Only the merchant knows when it's actually ready.
            (MerchantConfirmed, ReadyForPickup) => Some(RequesterOrMerchant),
            (ReadyForPickup, Cancelled) => Some(RequesterOrMerchant),
            // complete_pickup (dispatch coordinator) is always called by the
            // requester confirming they received it -- not reachable via a
            // generic status-set path, but still validated here regardless
            // of which coordinator function got here, same posture as
            // DeliveryOrder's (PickedUp, Delivered) arm.
            (ReadyForPickup, PickedUp) => Some(RequesterOrMerchant),
            // Disputes: whoever notices the problem should be able to raise
            // one -- same as DeliveryOrder's dispute-raising arms.
            (ReadyForPickup, Disputed) => Some(Any),
            (PickedUp, Disputed) => Some(Any),
            // Resolution: only a listed arbitrator, via
            // dispatch::apply_pickup_dispute_resolution -- same posture as
            // DeliveryOrder's own resolution arms.
            (Disputed, PickedUp) => Some(Arbitrator),
            (Disputed, Cancelled) => Some(Arbitrator),
            _ => None,
        }
    }
}

/// The pickup vertical's own entry type -- see `DeliveryStatus`'s doc
/// comment for why this is concrete and separate rather than a flag on
/// `DeliveryOrder`. Deliberately missing everything that only makes sense
/// with a driver in the loop: no `dropoff`/`dropoff_geohash`, no
/// `accepted_bid`, no `delivery_receipts`, no `tip_cents` (no driver to tip).
///
/// Named, accepted gap: every field this struct requires also exists with
/// the same name and type on `DeliveryOrder`, and `PickupStatus` shares 4 of
/// its 6 variant names with `DeliveryStatus` (`MerchantConfirmed`,
/// `PickedUp`, `Cancelled`, `Disputed`) -- so a `DeliveryOrder` currently
/// sitting in one of those statuses duck-type-decodes successfully as a
/// `PickupOrder` too (extra fields like `dropoff` are silently ignored by
/// serde's default struct deserialization). The reverse direction is
/// already blocked: `PickupOrder`'s bytes are missing `DeliveryOrder`'s own
/// required `dropoff`/`dropoff_geohash`/`delivery_receipts`, so that decode
/// always fails outright. This is *not* a cross-user attack surface --
/// every pickup coordinator function's authorization check (and
/// `validate_pickup_order_transition`'s own) draws `requester`/`merchant`
/// from fields that are genuinely real on whatever record actually got
/// resolved, so a confused decode still only lets that *same real order's*
/// own two legitimate parties touch it, never an unrelated third party, and
/// never moves funds. The honest, bounded risk: one of those two parties
/// (via a buggy or deliberately malicious custom client -- see
/// `force_order_update_for_testing`'s own doc comment for the identical
/// "coordinator zomes aren't part of the DNA hash" gap this app already
/// accepts elsewhere) could author a confusingly-typed update on their own
/// `DeliveryOrder`'s chain while it's in one of the 4 shared-name statuses,
/// permanently breaking that one order's own future `DeliveryOrder` reads
/// for every peer. Self-inflicted only, no cross-user harm, no fund theft.
/// A full fix (renaming the overlapping status variants, or checking each
/// resolved record's actual entry-type index rather than duck-typing) is a
/// larger undertaking than this narrow, non-adversarial edge case warrants
/// right now -- named here rather than silently missed.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct PickupOrder {
    pub requester: AgentPubKey,
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    /// What was ordered, each line priced at a specific version of its item
    /// -- validation recomputes `order_total` from these.
    pub lines: Vec<OrderLine>,
    pub order_total: u64,
    pub status: PickupStatus,
    pub dispute_ref: Option<ActionHash>,
    pub requested_at: Timestamp,
    /// The customer's note for the kitchen, sealed to the store.
    pub kitchen_note: Option<XSalsa20Poly1305EncryptedData>,
    /// Same trust tier/validation as `DeliveryOrder.promo_code_ref`.
    #[serde(default)]
    pub promo_code_ref: Option<ActionHash>,
    /// Same meaning and same trust tier as `DeliveryOrder.bag_claim_ref` --
    /// `Some` when this pickup originated from a confirmed goodie-bag
    /// claim rather than an ordinary menu order.
    #[serde(default)]
    pub bag_claim_ref: Option<ActionHash>,
    /// For a loyalty promo ("your 6th order here is 15% off"): the
    /// customer's own completions of earlier orders at this store, which
    /// validation counts. Empty otherwise.
    #[serde(default)]
    pub loyalty_proof: Vec<ActionHash>,
}
