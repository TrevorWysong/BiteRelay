//! `DeliveryOrder`/`Bid` struct definitions, factored out of `dispatch_integrity`
//! so `dispute_integrity` can decode a `DeliveryOrder` (to check who its real
//! parties are before accepting a dispute) without linking in
//! `dispatch_integrity`'s own wasm exports -- same reasoning as
//! `attestation_types`: two integrity zomes both exporting a symbol named
//! `validate` into the same wasm binary fails to link.

use hdi::prelude::*;
pub use dispute_types::{ArbitratorSeal, PinSecret};
use relay_types::GeoPoint;

mod issues;
mod settlement;
pub use issues::*;
pub use settlement::*;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum DeliveryStatus {
    /// A future-dated order that hasn't started matching yet -- see
    /// `DeliveryOrder.requested_delivery_time`. Never reachable via
    /// `set_order_status`'s generic path; only `request_delivery` (create)
    /// and `open_scheduled_order` (the one narrow transition out of it)
    /// touch this status.
    Scheduled,
    /// Placed and waiting for the store to accept it. Drivers never see an
    /// order until the store has -- so a store's refusal (sold out, busy,
    /// priced from an old menu) never costs a driver a trip.
    Placed,
    /// Accepted by the store and open to drivers' bids.
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
    /// The order's requester (the customer).
    Requester,
    /// The order's merchant (the store) -- the steps only the store can
    /// vouch for: accepting the order, preparing it, having it ready.
    Merchant,
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
            (Scheduled, Placed) => Some(Requester),
            (Scheduled, Cancelled) => Some(RequesterOrMerchant),
            // The store accepts (or declines) an order before any driver
            // sees it -- and only the store: its acceptance is the check that
            // the order is priced from its current menu
            // (`dispatch::accept_delivery_order`).
            (Placed, Open) => Some(Merchant),
            (Placed, Cancelled) => Some(RequesterOrMerchant),
            // Accepting a bid seals the address to that driver, which only the
            // customer can do.
            (Open, BidAccepted) => Some(Requester),
            (Open, Cancelled) => Some(RequesterOrMerchant),
            // The store starting to prepare it.
            (BidAccepted, MerchantConfirmed) => Some(Merchant),
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
            (PickedUp, Delivered) => Some(Requester),
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

/// Why an order was cancelled. Validation checks each reason against its
/// author, so the customer's view of what happened can be trusted.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Cancellation {
    /// The customer withdrew it.
    ByCustomer,
    /// The store declined it, or called it off after accepting.
    ByStore(DeclineReason),
    /// The store didn't accept it within the DNA's response window
    /// (`relay_governance::store_response_window`). Written by the
    /// customer's conductor, and only once the window has passed.
    StoreDidNotRespond,
    /// An arbitrator ruled for the customer.
    ByArbitrator,
}

/// What a store tells the customer when it turns an order down.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum DeclineReason {
    /// Priced from an outdated menu -- see `dispatch::accept_delivery_order`.
    OutdatedPrices,
    ItemsUnavailable,
    TooBusy,
    Closed,
    Other,
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
    /// Who it's for, so the driver can hand it over -- the customer's name.
    #[serde(default)]
    pub recipient: String,
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
    /// The customer's name, sealed to the store -- see `Profile::display_name`
    /// for why a customer publishes none.
    #[serde(default)]
    pub sealed_customer_name: Option<XSalsa20Poly1305EncryptedData>,
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
    /// Why the order was cancelled -- set by the update that cancels it,
    /// and checked against who wrote it. `None` until then.
    #[serde(default)]
    pub cancellation: Option<Cancellation>,
    /// When the store says the order will be ready -- set when it accepts
    /// the order, never changed after. `None` until then.
    #[serde(default)]
    pub ready_by: Option<Timestamp>,
    /// The customer's hold for the food (`settlement::HoldPurpose::Food`),
    /// cited by the store's update that accepts the order -- validation
    /// won't let a store accept an order whose food isn't paid for. Never
    /// changes after.
    #[serde(default)]
    pub food_hold: Option<ActionHash>,
    /// The customer's hold for the driver's pay -- their share of the fee,
    /// and their tip (`HoldPurpose::DriverPay`) -- cited by their update
    /// that accepts a bid.
    #[serde(default)]
    pub driver_pay_hold: Option<ActionHash>,
    /// The store's hold for its share of the fee (`HoldPurpose::Subsidy`),
    /// cited by its update that starts preparing the order.
    #[serde(default)]
    pub subsidy_hold: Option<ActionHash>,
    /// The driver's collateral hold (`HoldPurpose::Collateral`), cited by
    /// their update that picks the order up.
    #[serde(default)]
    pub collateral_hold: Option<ActionHash>,    /// The delivery PIN's commitment, `sha256(pin || salt)` -- 32 bytes, or
    /// empty for none. Public, and useless without the salt (see
    /// `dispute_types::PinSecret`).
    #[serde(default)]
    pub pin_commitment: Vec<u8>,
    /// The PIN and salt, sealed to the customer -- what their app shows.
    #[serde(default)]
    pub sealed_pin: Option<XSalsa20Poly1305EncryptedData>,
    /// The PIN and salt, sealed to each arbitrator on the roster, to check
    /// a driver's word against in a dispute.
    #[serde(default)]
    pub pin_for_arbitrators: Vec<ArbitratorSeal>,
    /// Whether the driver must collect the PIN at the door -- set by the
    /// store when it accepts the order (its `PinPolicy`), never changed.
    #[serde(default)]
    pub pin_required: bool,
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct Bid {
    pub order_ref: ActionHash,
    pub bidder: AgentPubKey,
    pub eta_seconds: u32,
    pub price_offer: u64,
    /// What the driver will post as collateral when they pick the order up
    /// -- always `settlement::required_collateral` of the order (validated).
    pub collateral: u64,
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
            // The store accepting the order and starting on it -- only the
            // store, after checking it's priced from its current menu
            // (`dispatch::confirm_pickup_prep`). Either side may cancel.
            (Placed, MerchantConfirmed) => Some(Merchant),
            (Placed, Cancelled) => Some(RequesterOrMerchant),
            (MerchantConfirmed, Cancelled) => Some(RequesterOrMerchant),
            // Only the merchant knows when it's actually ready.
            (MerchantConfirmed, ReadyForPickup) => Some(Merchant),
            (ReadyForPickup, Cancelled) => Some(RequesterOrMerchant),
            // complete_pickup (dispatch coordinator) is always called by the
            // requester confirming they received it -- not reachable via a
            // generic status-set path, but still validated here regardless
            // of which coordinator function got here, same posture as
            // DeliveryOrder's (PickedUp, Delivered) arm.
            (ReadyForPickup, PickedUp) => Some(Requester),
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
    /// The customer's name, sealed to the store.
    #[serde(default)]
    pub sealed_customer_name: Option<XSalsa20Poly1305EncryptedData>,
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
    /// Why the order was cancelled -- set by the update that cancels it,
    /// and checked against who wrote it. `None` until then.
    #[serde(default)]
    pub cancellation: Option<Cancellation>,
    /// When the store says the order will be ready -- set when it accepts
    /// the order, never changed after. `None` until then.
    #[serde(default)]
    pub ready_by: Option<Timestamp>,
    /// The customer's hold for the food, cited by the store's update that
    /// accepts the order -- see `DeliveryOrder::food_hold`.
    #[serde(default)]
    pub food_hold: Option<ActionHash>,
}
