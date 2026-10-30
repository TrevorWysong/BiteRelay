//! `MerchantCatalog`, `MenuItem`, and `PromoCode` struct definitions,
//! factored out of `catalog_integrity` so `dispatch_integrity` can decode
//! `PromoCode` entries (via `must_get_valid_record`) during its own
//! `validate_new_order`, the same reasoning `attestation_types` documents
//! for `Leg`/`ReceiptAttestation`: a plain dependency on `catalog_integrity`
//! itself won't work, since that crate's macros generate `#[no_mangle]`
//! wasm exports, and linking two integrity zomes that each export a symbol
//! named `validate` into the same wasm binary fails at link time. This
//! crate holds only the plain struct/enum defs -- no entry-type
//! registration, no externs.

use hdi::prelude::*;
use relay_types::GeoPoint;

mod hours;
mod modifiers;
mod pricing;
pub use hours::*;
pub use modifiers::*;
pub use pricing::*;

#[hdk_entry_helper]
#[derive(Clone)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct MerchantCatalog {
    pub owner: AgentPubKey,
    pub business_name: String,
    pub location: GeoPoint,
    pub geohash: String,
    pub is_open: bool,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub cuisine_type: String,
    #[serde(default)]
    pub banner_data_uri: String,
    #[serde(default)]
    pub phone: String,
    /// Split into one field per address component (street/city/state/zip)
    /// rather than one flat string -- lets `publish_catalog`'s own address
    /// search (`AddressSearch`'s `onSelectComponents`) prefill every field
    /// at once, and keeps them independently editable afterward in
    /// `update_catalog_details` without a merchant having to re-type the
    /// whole address to fix just one part of it.
    #[serde(default)]
    pub address_street: String,
    #[serde(default)]
    pub address_city: String,
    #[serde(default)]
    pub address_state: String,
    #[serde(default)]
    pub address_zip: String,
    /// When the store takes orders, in `time_zone` (see `hours`). Empty
    /// means no set hours: open whenever `is_open` is on.
    #[serde(default)]
    pub weekly_hours: Vec<OpeningPeriod>,
    /// The store's IANA time zone ("America/New_York") -- what its hours
    /// mean. From the merchant's device when they set up or edit the store.
    #[serde(default = "utc")]
    pub time_zone: String,
    /// How long the kitchen usually takes, in minutes -- the default when
    /// the store accepts an order, which records when it'll be ready.
    pub prep_minutes: u16,
    /// What share (0-100) of a winning bid's delivery fee this merchant
    /// covers. A new store starts at the network's default
    /// (`relay_governance::default_delivery_subsidy_percent`).
    pub delivery_subsidy_percent: u8,
    /// Whether the store's conductor accepts new orders as they arrive
    /// (still declining any priced from an outdated menu), rather than
    /// waiting for someone to tap Accept.
    #[serde(default)]
    pub auto_accept_orders: bool,
    /// The most an order may cost to be left at the door, in cents -- above
    /// it, the store's deliveries are always handed over. A customer who
    /// chooses the door accepts the risk once it's left there; a store sets
    /// this to keep its expensive orders out of that. `None`: no limit.
    #[serde(default)]
    pub leave_at_door_max_cents: Option<u64>,
    /// The smallest order the store takes, in minor units of its items'
    /// prices before any promo (a goodie bag is priced on its own). `None`:
    /// any size.
    #[serde(default)]
    pub min_order_cents: Option<u64>,
    /// Minutes the store is adding to its usual prep time while it's busy
    /// -- 0 when it isn't. Customers see the longer wait before ordering.
    #[serde(default)]
    pub busy_extra_minutes: u16,
    /// How long past an order's ready time the store may keep a checked-in
    /// driver waiting before they can call it late -- leaving paid in full
    /// by the store, while the order goes to another driver and its
    /// customer may cancel for a full refund. Part of the terms an order is
    /// placed under; customers see it at checkout. `None`: the network's
    /// (`relay_governance::store_wait`), within its bounds.
    #[serde(default)]
    pub store_wait_minutes: Option<u16>,
    /// How far from `location` this merchant is willing to deliver, in
    /// kilometers -- a per-merchant business rule, not a single app-wide
    /// constant: a dense-downtown restaurant and a rural one have
    /// genuinely different realistic delivery ranges, so this has to be
    /// each merchant's own call, not something the app hardcodes for
    /// everyone. Enforced by `dispatch_integrity::validate_new_order`
    /// against the order's public drop-off cell (deterministic, so every
    /// peer agrees), and bounded by the network
    /// (`relay_governance::max_delivery_radius_km`). A new store starts at
    /// the network's default.
    pub max_delivery_radius_km: f64,
    /// A sorted, deduplicated union of every available menu item's
    /// `dietary_tags`, maintained by `catalog_coordinator::add_menu_item`/
    /// `update_menu_item` (never set directly by a client) -- denormalized
    /// specifically so Browse can filter restaurants by dietary tag without
    /// fetching every candidate's full menu on every browse load. This
    /// moves the cost to the rare path (a merchant editing their menu)
    /// away from the hot one (a customer browsing), the same tradeoff
    /// `ledger`/`reputation`'s checkpoint mechanism makes for the opposite
    /// reason. Not independently verified in
    /// `validate()` -- recomputing "is this really the union of all this
    /// catalog's menu items" deterministically would need a non-deterministic
    /// `get_links` walk inside `validate()`, the same category of gap
    /// `order_total` already has (never independently re-derived either).
    #[serde(default)]
    pub dietary_tags: Vec<String>,
    /// The sales tax or VAT the store charges, by category of item -- its
    /// first rate is the default. Empty: no tax. The store's own, for its
    /// own address: it's the seller, and files what it collects
    /// (docs/SALES_TAX.md). Part of the terms an order is placed under.
    #[serde(default)]
    pub tax_rates: Vec<TaxRate>,
    /// Whether menu prices already include the tax (VAT, as in most of the
    /// world), rather than having it added at checkout (US sales tax).
    #[serde(default)]
    pub prices_include_tax: bool,
    /// The store's tax registration (a sales tax permit, a VAT number),
    /// shown on receipts. Empty for none.
    #[serde(default)]
    pub tax_registration: String,
}

/// One tax rate a store charges.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct TaxRate {
    /// What it applies to, as items name it: "prepared", "grocery".
    pub category: String,
    /// What receipts call it: "Sales tax", "VAT 20%".
    pub label: String,
    /// In basis points (1/100 of a percent).
    pub basis_points: u16,
}

/// The most tax rates a store may have, and the highest rate.
pub const MAX_TAX_RATES: usize = 8;
pub const MAX_TAX_BASIS_POINTS: u16 = 5_000;

pub fn utc() -> String {
    "UTC".into()
}

#[hdk_entry_helper]
#[derive(Clone)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct MenuItem {
    pub catalog_ref: ActionHash,
    pub name: String,
    pub price_cents: u64,
    pub available: bool,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub photo_data_uri: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub dietary_tags: Vec<String>,
    /// The choice groups a customer picks from when ordering it, in the
    /// order they're shown: each a `ModifierGroup` of the same store, by
    /// its original action -- so a store edits a shared group ("Choose a
    /// side") once for every item that offers it.
    #[serde(default)]
    pub modifier_groups: Vec<ActionHash>,
    /// Which of its store's tax rates applies (`TaxRate::category`) --
    /// empty for the store's first.
    #[serde(default)]
    pub tax_category: String,
    /// Sold only to adults (alcohol, tobacco): collected in person, where
    /// the store checks ID, and only on a network that sets the age
    /// (`relay_governance::restricted_min_age`).
    #[serde(default)]
    pub age_restricted: bool,
}

/// What a cart must satisfy for a `PromoCode` to apply -- the "purchase
/// criteria" half of the same requirement/reward split DoorDash's own
/// Promotion Management API uses (`purchase_criteria` + `discount_options`,
/// two separate, paired objects rather than one flat discount value).
/// Deliberately generic rather than one struct per promo flavor: a new
/// condition (e.g. "customer's first order") is a new variant here, not a
/// change to `PromoCode`, `PromoReward`, or any validation/evaluation code
/// that doesn't specifically care about that condition.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum PromoRequirement {
    /// Always eligible once redeemed -- a plain code with no purchase
    /// condition (what the old flat `PercentOff`/`FlatCentsOff`-only design
    /// always meant, now one case among several instead of the only one).
    None,
    /// Cart subtotal (pre-discount, in cents) must be at least this much.
    /// The "spend $X, get something free" shape.
    MinimumSpend(u64),
    /// Cart must contain at least `quantity` units of `item_ref` (a
    /// `MenuItem` belonging to the same catalog -- checked in
    /// `catalog_integrity::validate_new_promo_code`). The "buy X" half of
    /// a buy-X-get-Y deal, including BOGO (`quantity: 1`).
    MinimumItemQuantity { item_ref: ActionHash, quantity: u32 },
    /// The customer must have at least `count` of their own prior
    /// `Delivered` orders at *this* catalog -- the loyalty-reward shape
    /// ("order 5 times, your 6th is discounted"). Deliberately **not**
    /// independently checkable inside `validate()`: counting an agent's
    /// own order history is exactly the non-deterministic forward-reference
    /// query this codebase has hit repeatedly (see `order_total`'s own
    /// trust-tier note) -- evaluated client-side/best-effort only, same
    /// tier as the arithmetic on every other requirement/reward here.
    LoyaltyOrderCount(u32),
}

/// The benefit a `PromoCode` grants once its `PromoRequirement` is met --
/// the "discount_options" half. Each variant is a distinct *shape* of
/// benefit (whole-order vs. item-scoped, percent vs. flat/free), not a
/// distinct promo "type" -- requirement and reward are chosen independently,
/// so e.g. `MinimumSpend` + `FreeItem` and `MinimumItemQuantity` + `FreeItem`
/// are both just "this requirement, that reward," not two hardcoded
/// promo-type branches anywhere in validation or evaluation code.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum PromoReward {
    /// 1-100, applied to the whole (pre-discount) cart subtotal.
    PercentOffSubtotal(u8),
    /// Cents, applied to the whole subtotal, clamped so it can't exceed it.
    FlatOffSubtotal(u64),
    /// Up to `quantity` units of `item_ref` (a `MenuItem` belonging to the
    /// same catalog) become free. The generic shape behind both
    /// "spend $X, get item Y free" and buy-X-get-Y-free/BOGO deals --
    /// which one it is depends entirely on the paired `PromoRequirement`,
    /// not on anything here.
    FreeItem { item_ref: ActionHash, quantity: u32 },
    /// Up to `quantity` units of `item_ref` get `percent` (1-100) off
    /// instead of fully free -- e.g. "buy a burger, get a second burger
    /// 50% off."
    PercentOffItem { item_ref: ActionHash, percent: u8, quantity: u32 },
}

/// Merchant-scoped, not global -- one restaurant's "WELCOME10" is a
/// completely independent code from another's, looked up by
/// `(catalog_ref, code)` rather than a globally unique string. Immutable
/// once created except `active` (see `catalog_coordinator::set_promo_code_active`)
/// -- a code's actual requirement/reward never changes after the fact, only
/// whether it can still be used.
#[hdk_entry_helper]
#[derive(Clone)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct PromoCode {
    pub catalog_ref: ActionHash,
    pub code: String,
    pub requirement: PromoRequirement,
    pub reward: PromoReward,
    pub active: bool,
    pub expires_at: Option<Timestamp>,
    pub created_at: Timestamp,
    /// When `true`, an eligible customer gets this reward applied without
    /// ever typing a code -- the mechanism loyalty rewards need (nobody
    /// "types in" having ordered 5 times), but deliberately orthogonal to
    /// any specific requirement/reward combo: a merchant could just as
    /// well make a "spend $50, free dessert" deal auto-apply too. Defaults
    /// `false` so every existing promo's "customer must type the code"
    /// behavior is unchanged.
    #[serde(default)]
    pub auto_apply: bool,
}

/// A goodie bag: a quantity-limited, time-windowed, discounted mystery bag
/// of surplus food. Deliberately not itemized the
/// way a `MenuItem`-based order is -- the contents are the merchant's own
/// call at pickup/pack time, which is the entire point (the customer is
/// buying "today's surplus," not a specific dish). Lives in `catalog_types`
/// (not a new zome) for the same reason `MenuItem`/`PromoCode` do: it's a
/// merchant-listing concept, sharing this crate's owner/catalog-ownership
/// discipline rather than duplicating cross-zome wiring a whole new zome
/// would need.
#[hdk_entry_helper]
#[derive(Clone)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct GoodieBag {
    pub catalog_ref: ActionHash,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub photo_data_uri: String,
    pub original_value_cents: u64,
    pub price_cents: u64,
    pub quantity_total: u32,
    pub pickup_window_start: Timestamp,
    pub pickup_window_end: Timestamp,
    pub supports_pickup: bool,
    pub supports_delivery: bool,
    pub created_at: Timestamp,
    /// How long a confirmed claim is held for its customer to order it.
    /// Unordered by then, it lapses and the bag goes back on sale -- so
    /// nobody can hold a store's bags without buying them.
    pub hold_minutes: u16,
}

/// The integrity zome these types belong to -- how another zome's
/// validation recognises one of its links.
pub const CATALOG_INTEGRITY_ZOME: &str = "catalog_integrity";

/// What begins the tag of a store's listing link (`GeohashToCatalog`) -- and
/// only of one: validation refuses it on any other catalog link, so a tag
/// that starts with it is a listing.
pub const LISTING_TAG_PREFIX: &[u8] = b"listing:";

/// A store listing's link tag: the stake (`ledger_types::LedgerKind::Stake`)
/// that backs it.
pub fn listing_tag(stake: &ActionHash) -> Vec<u8> {
    [LISTING_TAG_PREFIX, stake.get_raw_39()].concat()
}

/// The stake a listing's tag names, if it's a listing tag.
pub fn listing_stake(tag: &[u8]) -> Option<ActionHash> {
    let raw = tag.strip_prefix(LISTING_TAG_PREFIX)?;
    ActionHash::try_from_raw_39(raw.to_vec()).ok()
}

impl MerchantCatalog {
    /// Whether an order placed under these terms gets more from the store
    /// than `current` would give it: a lower minimum, a wider delivery
    /// area, or a larger share of the delivery fee. Anything else about a
    /// store (its hours, its description, being busy) changes nothing an
    /// order holds the store to.
    pub fn offers_more_than(&self, current: &MerchantCatalog) -> bool {
        self.min_order_cents.unwrap_or(0) < current.min_order_cents.unwrap_or(0)
            || self.max_delivery_radius_km > current.max_delivery_radius_km
            || self.delivery_subsidy_percent > current.delivery_subsidy_percent
    }
}

impl GoodieBag {
    /// When a claim the store confirmed at `confirmed_at` lapses, if it's
    /// still unordered: its hold, plus `answer_window` -- the time a store
    /// has to accept an order placed at the hold's last moment.
    pub fn claim_lapses_at(&self, confirmed_at: Timestamp, answer_window: core::time::Duration) -> Timestamp {
        Timestamp::from_micros(confirmed_at.as_micros() + i64::from(self.hold_minutes) * 60_000_000 + answer_window.as_micros() as i64)
    }
}

/// What a customer chose when claiming a bag -- captured once, up front, so
/// confirmation can automatically finalize into a real order with no
/// further input needed (see `BagClaim`'s own doc comment).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum BagClaimFulfillment {
    Pickup,
    /// `sealed_dropoff` is the drop-off point, sealed to the customer: the
    /// store only needs to know it's a delivery, never where to.
    Delivery { sealed_dropoff: XSalsa20Poly1305EncryptedData, max_delivery_fee: Option<u64> },
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum BagClaimStatus {
    Pending,
    /// The store set a bag aside for this customer, for its `hold_minutes`.
    Confirmed,
    /// The store accepted the customer's order for it: sold.
    Redeemed,
}

/// A customer's claim against a `GoodieBag` -- the `Bid`-shaped half of
/// this feature's scarcity resolution (see the architecture doc's own
/// reasoning: a scarce resource on a DHT with no distributed locks is
/// resolved by a single authoritative party deciding, the same shape
/// `accept_bid` already uses, not a race on a shared counter).
///
/// Confirming a claim (`catalog::confirm_claim`) is authored by the
/// merchant -- an agent authoring a record *about* someone else, the same
/// "agent A updates a record naming agent B" pattern
/// `dispute::submit_resolution`/`reputation::record_event` already use.
/// Holochain requires every entry to be authored on its own agent's chain,
/// so the merchant's confirmation can only flip *this* claim's own status;
/// it cannot also author the resulting `PickupOrder`/`DeliveryOrder` on the
/// customer's behalf. The customer's own client, seeing (via poll or
/// signal) that their claim is `Confirmed`, finalizes it themselves by
/// calling `dispatch::request_pickup_order`/`request_delivery` with this
/// same `fulfillment` data already in hand -- fully automatic from their
/// side, no extra tap needed.
#[hdk_entry_helper]
#[derive(Clone)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct BagClaim {
    pub bag_ref: ActionHash,
    pub customer: AgentPubKey,
    pub fulfillment: BagClaimFulfillment,
    pub status: BagClaimStatus,
    pub claimed_at: Timestamp,
}


#[cfg(test)]
mod bag_hold_tests {
    use super::*;

    fn bag(hold_minutes: u16) -> GoodieBag {
        GoodieBag {
            catalog_ref: ActionHash::from_raw_36(vec![0; 36]),
            title: "Bag".into(),
            description: String::new(),
            photo_data_uri: String::new(),
            original_value_cents: 2000,
            price_cents: 500,
            quantity_total: 1,
            pickup_window_start: Timestamp::from_micros(0),
            pickup_window_end: Timestamp::from_micros(1),
            supports_pickup: true,
            supports_delivery: false,
            created_at: Timestamp::from_micros(0),
            hold_minutes,
        }
    }

    #[test]
    fn a_claim_lapses_after_its_hold_and_the_time_to_accept_an_order() {
        let confirmed = Timestamp::from_micros(1_000_000);
        let lapses = bag(30).claim_lapses_at(confirmed, core::time::Duration::from_secs(300));
        assert_eq!(lapses.as_micros(), 1_000_000 + 30 * 60_000_000 + 300_000_000);
    }
}

/// A store carried on to its owner's new key: `to`, a copy of `from` --
/// details, choice groups, menu and promo codes -- published by the key
/// that took over the account that owned `from` (`succession`, the
/// account zome's `Succession`). A key can't change another's entries, so
/// a store moves by being republished, and this ties the two together:
/// ratings follow it, and customers are sent on from the old one.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct StoreSuccession {
    /// The old store, by its original action.
    pub from: ActionHash,
    /// The new store, by its original action.
    pub to: ActionHash,
    /// The author's succession of the old store's owner.
    pub succession: ActionHash,
}

/// A store brought over from the previous version of the network
/// (docs/MIGRATION.md): `to`, the author's own store here, republished from
/// `from`, a store on `previous_network`. Validation here can't read the
/// previous network, so apps count `from`'s history as `to`'s only once
/// they've checked there that `from`'s owner moved their account to the
/// author.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct StoreImport {
    pub previous_network: DnaHash,
    pub from: ActionHash,
    pub to: ActionHash,
}
