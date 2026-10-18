//! `DeliveryOrder`/`Bid` struct definitions, factored out of `dispatch_integrity`
//! so other integrity zomes (the ledger, reputation) can decode orders without
//! linking in `dispatch_integrity`'s own wasm exports -- same reasoning as
//! `attestation_types`: two integrity zomes both exporting a symbol named
//! `validate` into the same wasm binary fails to link.

use hdi::prelude::*;
pub use catalog_types::{Chosen, ChosenInput, Selection, SelectionInput};
pub use relay_types::{Beacon, PinSecret};
use relay_types::GeoPoint;

mod issues;
pub mod lineage;
mod settlement;

/// How precisely a delivery's drop-off is published (`dropoff_geohash`): a
/// geohash cell of about 1.2 x 0.6 km -- enough for drivers to see it's
/// nearby, never the address itself.
pub const DROPOFF_GEOHASH_PRECISION: usize = 6;
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
    /// The customer has chosen a driver, who has the network's offer window
    /// to commit.
    BidAccepted,
    /// The driver has committed -- their collateral set aside -- and is on
    /// their way. The store starts cooking only now, so an order no driver
    /// takes costs nobody anything.
    DriverEnRouteToMerchant,
    /// The store is cooking it: `ready_by` is set.
    MerchantConfirmed,
    /// The store has checked the driver in, at the counter -- setting aside
    /// what it owes if it then keeps them waiting (`HoldPurpose::Subsidy`).
    DriverAtStore,
    PickedUp,
    Delivered,
    Cancelled,
    Disputed,
    /// No driver brought it, so the customer is collecting it from the store
    /// themselves -- at the same food price, since Relay's fees are the same
    /// for both.
    Collecting,
    /// The customer has it, collected from the store. Final.
    Collected,
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
    /// The requester or the accepted provider -- completing a delivery, on
    /// proof the customer has it.
    RequesterOrProvider,
    /// The store or the accepted provider -- a driver leaving an order, by
    /// their own choice or the store's.
    MerchantOrProvider,
    /// Any of the three.
    AnyParty,
}

impl DeliveryStatus {
    /// Finished from the store's point of view -- it leaves the store's
    /// active queue (see `dispatch_integrity::store_queue`).
    pub fn is_terminal(&self) -> bool {
        matches!(self, DeliveryStatus::Delivered | DeliveryStatus::Collected | DeliveryStatus::Cancelled)
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
            // The driver committing, with their collateral; then the store
            // cooking; then the store checking them in at the counter; then
            // the driver collecting it, on the store's record of handing it
            // over.
            (BidAccepted, DriverEnRouteToMerchant) => Some(AcceptedProvider),
            (DriverEnRouteToMerchant, MerchantConfirmed) => Some(Merchant),
            (MerchantConfirmed, DriverAtStore) => Some(Merchant),
            (DriverAtStore, PickedUp) => Some(AcceptedProvider),
            // Before it's picked up, either side can call it off -- and a
            // driver kept waiting can call the store late.
            (BidAccepted | DriverEnRouteToMerchant | MerchantConfirmed, Cancelled) => Some(RequesterOrMerchant),
            (DriverAtStore, Cancelled) => Some(AnyParty),
            // A driver leaving before pickup: dropping it, or -- before
            // they're checked in -- the store moving it on from a driver who
            // didn't commit in time, or is late. It's open to bids again.
            (BidAccepted | DriverEnRouteToMerchant | MerchantConfirmed, Open) => Some(MerchantOrProvider),
            (DriverAtStore, Open) => Some(AcceptedProvider),
            // Completing it, on proof the customer has it (see
            // `attestation_types::dropoff_proof`) -- by the customer, or by
            // the driver holding that proof. Final: a delivered order can't
            // be claimed undelivered.
            (PickedUp, Delivered) => Some(RequesterOrProvider),
            // The customer's claim that it never arrived. The store decides
            // what follows (`OrderOutcome`); until it has, a driver who turns
            // up late can still complete it with proof.
            (PickedUp, Disputed) => Some(Requester),
            (Disputed, Delivered) => Some(RequesterOrProvider),
            // The customer collecting it themselves, at their request
            // (`CollectRequest`), when no driver has it or its driver is late
            // -- recorded by the store, which hands it over.
            (Open | BidAccepted | DriverEnRouteToMerchant | MerchantConfirmed, Collecting) => Some(Merchant),
            // Collected -- on the customer's word, or the store's scan of
            // their handover code.
            (Collecting, Collected) => Some(RequesterOrMerchant),
            // Cancelled by the customer (who still owes the food), or
            // recorded uncollected by the store once the window has passed.
            (Collecting, Cancelled) => Some(RequesterOrMerchant),
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
    /// The customer chose to collect it and never came within the
    /// collection window. Written by the store, which keeps the food's
    /// price: it cooked it.
    NotCollected,
    /// The store kept a checked-in driver waiting past the network's wait
    /// (`relay_governance::store_wait`) after its ready time. Written by the
    /// driver, with proof of the time: the customer is refunded, and the
    /// store pays the driver's fee.
    StoreLate,
    /// A driver left after the store had started cooking, and no other came
    /// within the network's window (`relay_governance::replacement_window`).
    /// Written by the store: the customer is refunded, and that driver's
    /// collateral pays for the food.
    NoDriver,
}

/// What a store tells the customer when it turns an order down.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum DeclineReason {
    /// Priced from an outdated menu -- see `dispatch::accept_delivery_order`.
    OutdatedPrices,
    ItemsUnavailable,
    TooBusy,
    Closed,
    /// It redeems a goodie bag whose hold ran out before the order came in
    /// -- the bag went back on sale.
    BagHoldLapsed,
    /// Placed under the store's earlier terms -- its minimum order,
    /// delivery area or fee share -- which had since changed.
    TermsChanged,
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
    /// Left at the door: delivered once it's left there, at the customer's
    /// risk (`DeliveryOrder::door_risk_accepted`).
    LeaveAtDoor,
    /// Handed over -- the default: proved by the customer's code or their
    /// own confirmation.
    #[default]
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
/// there), what was chosen from its choice groups, and how many. The same
/// item may be on several lines, each with different choices.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct OrderLine {
    /// The item's identity (its original action). For a goodie-bag order,
    /// the bag.
    pub item_ref: ActionHash,
    /// The version priced: `item_ref` itself or one of its updates.
    pub priced_version: ActionHash,
    pub quantity: u32,
    /// One per choice group of the priced version, in its order, each at
    /// the group version priced (`catalog_types::line_price`). None for an
    /// item without choices, or a goodie bag.
    #[serde(default)]
    pub selections: Vec<Selection>,
}

/// Something to order -- an item, how many, and what was chosen -- before
/// it's priced: what a customer's app sends, and what a recurring order
/// keeps.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct OrderItem {
    pub item_ref: ActionHash,
    pub quantity: u32,
    #[serde(default)]
    pub selections: Vec<SelectionInput>,
}

/// A customer's exact drop-off (`DropoffDetails`), sealed to the driver who
/// has committed to their order -- shared by the customer's app once they
/// have, so only a driver with collateral at stake ever learns where anyone
/// lives: a throwaway identity can't win a bid just to harvest addresses.
/// A record of its own, linked from the order, rather than a version of the
/// order: sharing it never races another party's step.
#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct DropoffShare {
    /// The order's original action.
    pub order: ActionHash,
    /// A version of the order showing `driver` committed to it.
    pub committed: ActionHash,
    pub driver: AgentPubKey,
    pub sealed: XSalsa20Poly1305EncryptedData,
}

/// Prices an order's lines with their choices, reading each choice group
/// version the order names once however many lines name it.
#[derive(Default)]
pub struct LinePricer {
    groups: std::collections::BTreeMap<ActionHash, Option<catalog_types::GroupAt>>,
}

impl LinePricer {
    /// What one unit of a line costs: `item` (the line's priced version)
    /// with the line's choices, each group read at the version the line
    /// names -- or why the choices don't fit the item. Deterministic: what
    /// validation checks an order's total and a refund's worth against.
    pub fn unit_price(&mut self, item: &catalog_types::MenuItem, selections: &[Selection]) -> ExternResult<Result<u64, String>> {
        let groups = &mut self.groups;
        catalog_types::line_price(item, selections, &mut |version: &ActionHash| {
            if let Some(known) = groups.get(version) {
                return Ok(known.clone());
            }
            let record = must_get_valid_record(version.clone())?;
            let found = match relay_integrity_support::decode::<catalog_types::ModifierGroup>(&record) {
                Some(group) => Some((relay_integrity_support::original_creation(version.clone())?, group)),
                None => None,
            };
            groups.insert(version.clone(), found.clone());
            Ok(found)
        })
    }
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
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct DeliveryOrder {
    pub requester: AgentPubKey,
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    /// The version of the store the order was placed against -- whose
    /// delivery radius and fee split it was placed under. Validation checks
    /// both against it.
    pub catalog_version: ActionHash,
    /// What was ordered, each line priced at a specific version of its item
    /// -- validation recomputes `order_total` from these.
    pub lines: Vec<OrderLine>,
    /// What the customer pays the store: the lines less any promo, plus the
    /// tax when the store adds it at checkout -- everything the food hold
    /// sets aside, refunds share, and the store collects.
    pub order_total: u64,
    /// The sales tax or VAT in `order_total`, at the rates of the store
    /// version the order cites -- validation recomputes it. The store
    /// remits it.
    #[serde(default)]
    pub tax_cents: u64,
    /// The drop-off's area (a geohash cell of `DROPOFF_GEOHASH_PRECISION`,
    /// about 1.2 x 0.6 km) -- all that's public about where the order goes:
    /// enough for drivers nearby to find it and judge the trip, and for
    /// validation to check it's within the store's radius. The exact point
    /// is in `sealed_dropoff`.
    pub dropoff_geohash: String,
    /// The exact drop-off and the customer's drop-off notes
    /// (`DropoffDetails`), sealed to the customer themselves.
    pub sealed_dropoff: XSalsa20Poly1305EncryptedData,
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
    /// Empty until the order is delivered, then the proof it reached the
    /// customer: the driver's drop-off leg and, unless that leg carries the
    /// customer's scanned code or was left at the door as they chose, the
    /// customer's own `ReceiptAttestation` of it (see
    /// `attestation_types::dropoff_proof`). Carried on the entry so
    /// validation checks it deterministically, for every peer.
    pub delivery_receipts: Vec<ActionHash>,
    pub requested_at: Timestamp,
    #[serde(default)]
    pub tip_cents: u64,
    /// The store's share of the delivery fee, in percent -- the split in
    /// force when the order was placed (`catalog_version`'s
    /// `delivery_subsidy_percent`, which validation checks), fixed for this
    /// order. The store accepts it by confirming the order; settlement and
    /// ledger validation both read it from here.
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
    /// treatment as the other per-order fields above.
    #[serde(default)]
    pub dropoff_preference: DropoffPreference,
    /// The customer accepting that an order left at their door is
    /// delivered once it's left -- required for `LeaveAtDoor`, and only for
    /// it. Fixed when the order is placed.
    #[serde(default)]
    pub door_risk_accepted: bool,
    /// The customer asking for a driver of their own: nobody picks this
    /// order up while carrying another, or picks another up while carrying
    /// it (`ledger_types::InHand`). Fixed when the order is placed.
    #[serde(default)]
    pub priority: bool,
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
    /// How long the store said the kitchen would take, when it accepted the
    /// order -- what drivers and the customer see until it starts cooking.
    /// Never changes after.
    #[serde(default)]
    pub prep_minutes: Option<u16>,
    /// When the store says the order will be ready: when it started
    /// cooking (once a driver had committed, or the customer chose to
    /// collect it), plus `prep_minutes`. Set once, never changed after.
    #[serde(default)]
    pub ready_by: Option<Timestamp>,
    /// The customer's hold for the food (`settlement::HoldPurpose::Food`),
    /// cited by the store's update that accepts the order -- validation
    /// won't let a store accept an order whose food isn't paid for. Never
    /// changes after.
    #[serde(default)]
    pub food_hold: Option<ActionHash>,
    /// The customer's hold for the current driver's pay -- their share of
    /// the fee, and their tip (`HoldPurpose::DriverPay`) -- cited by their
    /// update that accepts a bid, and gone with that driver.
    #[serde(default)]
    pub driver_pay_hold: Option<ActionHash>,
    /// The store's hold for the current driver (`HoldPurpose::Subsidy`): its
    /// share of their fee, and what it owes them if it keeps them waiting --
    /// cited by its update checking them in.
    #[serde(default)]
    pub subsidy_hold: Option<ActionHash>,
    /// The current driver's collateral hold (`HoldPurpose::Collateral`),
    /// cited by their update committing to the order.
    #[serde(default)]
    pub collateral_hold: Option<ActionHash>,
    /// The customer's handoff code's commitment, `sha256(pin || salt)` (see
    /// `PinSecret`) -- 32 bytes. Fixed when the order is placed.
    pub pin_commitment: Vec<u8>,
    /// The customer's code, sealed to themselves -- what their app shows.
    pub sealed_pin: XSalsa20Poly1305EncryptedData,
    /// The store's check-in code's commitment -- set when it accepts the
    /// order, never changed after. Empty until then. A driver scans the
    /// code at the counter to be checked in.
    #[serde(default)]
    pub pickup_commitment: Vec<u8>,
    /// The store's check-in code, sealed to the store.
    #[serde(default)]
    pub sealed_pickup_code: Option<XSalsa20Poly1305EncryptedData>,
    /// Proof the driver has the food, cited by their update picking it up:
    /// the store's own `ReceiptAttestation` of their pickup -- it handed the
    /// order over. Never changes after.
    #[serde(default)]
    pub pickup_proof: Option<ActionHash>,
    /// The customer's handover code, as the store scanned it when they
    /// collected the order themselves -- the store's proof they have it.
    /// Set only by that step.
    #[serde(default)]
    pub collection_proof: Option<PinSecret>,
    /// The customer's request to collect it themselves, cited by the
    /// store's update recording it -- the customer's consent.
    #[serde(default)]
    pub collect_request: Option<ActionHash>,
    /// For an update whose rule turns on a deadline someone else could
    /// dispute -- a driver leaving, or calling the store late: proof of when
    /// it was written, fresh on that update. Later updates carry it forward.
    #[serde(default)]
    pub beacon: Option<Beacon>,
    /// The customer letting their app choose a driver from the bids, by the
    /// network's published rule. Fixed when the order is placed.
    #[serde(default)]
    pub auto_match: bool,
}

/// A customer asking to collect their delivery from the store themselves --
/// when no driver has it, or its driver is late. The store records it
/// (`DeliveryStatus::Collecting`), citing this. One per order.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct CollectRequest {
    /// The order's original action.
    pub order: ActionHash,
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct Bid {
    pub order_ref: ActionHash,
    pub bidder: AgentPubKey,
    /// How long until the driver would hand the order to its customer.
    pub eta_seconds: u32,
    /// How long until they'd reach the store -- with the store's ready time,
    /// when they're due there (see `relay_governance::pickup_grace`). At most
    /// `eta_seconds`.
    #[serde(default)]
    pub to_store_seconds: u32,
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
            // The customer saying they can't get their order. The store
            // either hands it over (the customer then collects it) or
            // cancels it, returning their money.
            (ReadyForPickup, Disputed) => Some(Requester),
            (Disputed, PickedUp) => Some(Requester),
            (Disputed, Cancelled) => Some(Merchant),
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
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct PickupOrder {
    pub requester: AgentPubKey,
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    /// The version of the store the order was placed against -- whose
    /// minimum order it was placed under. Validation checks it.
    pub catalog_version: ActionHash,
    /// What was ordered, each line priced at a specific version of its item
    /// -- validation recomputes `order_total` from these.
    pub lines: Vec<OrderLine>,
    /// What the customer pays the store: the lines less any promo, plus the
    /// tax when the store adds it at checkout -- everything the food hold
    /// sets aside, refunds share, and the store collects.
    pub order_total: u64,
    /// The sales tax or VAT in `order_total`, at the rates of the store
    /// version the order cites -- validation recomputes it. The store
    /// remits it.
    #[serde(default)]
    pub tax_cents: u64,
    pub status: PickupStatus,
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
    /// The customer's word that they're old enough for the order's
    /// age-restricted items, and will show ID at the counter -- required
    /// when it has any.
    #[serde(default)]
    pub age_confirmed: bool,
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

#[cfg(test)]
mod type_confusion_tests {
    use super::*;

    fn hash(n: u8) -> ActionHash {
        ActionHash::from_raw_36(vec![n; 36])
    }

    #[test]
    fn a_record_decodes_only_as_its_own_type() {
        // A shared address names its order, as a collect request does: it
        // must never read as the customer asking to collect.
        let share = DropoffShare {
            order: hash(1),
            committed: hash(2),
            driver: AgentPubKey::from_raw_36(vec![3; 36]),
            sealed: XSalsa20Poly1305EncryptedData::new([0; 24].into(), vec![0; 16]),
        };
        let bytes = SerializedBytes::try_from(share).unwrap();
        assert!(CollectRequest::try_from(bytes).is_err());
        let request = SerializedBytes::try_from(CollectRequest { order: hash(1) }).unwrap();
        assert!(CollectRequest::try_from(request).is_ok());
    }
}
