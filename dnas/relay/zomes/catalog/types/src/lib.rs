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
mod pricing;
pub use hours::*;
pub use pricing::*;

#[hdk_entry_helper]
#[derive(Clone)]
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
    #[serde(default = "default_prep_minutes")]
    pub prep_minutes: u16,
    /// What share (0-100) of a winning bid's delivery fee this merchant
    /// covers -- see architecture plan §12 (2026-10-01 revision) for why
    /// this defaults to 50, not 0.
    #[serde(default = "default_delivery_subsidy_percent")]
    pub delivery_subsidy_percent: u8,
    /// Whether the store's conductor accepts new orders as they arrive
    /// (still declining any priced from an outdated menu), rather than
    /// waiting for someone to tap Accept.
    #[serde(default)]
    pub auto_accept_orders: bool,
    /// How far from `location` this merchant is willing to deliver, in
    /// kilometers -- a per-merchant business rule, not a single app-wide
    /// constant: a dense-downtown restaurant and a rural one have
    /// genuinely different realistic delivery ranges, so this has to be
    /// each merchant's own call, not something the app hardcodes for
    /// everyone. Enforced for real in `dispatch_integrity::validate_new_order`
    /// via `relay_types::distance_km` (deterministic, so every peer agrees
    /// on the same reject/accept outcome) -- not just an advisory UI hint.
    /// Defaults to a conservative 8km for every catalog published before
    /// this field existed.
    #[serde(default = "default_max_delivery_radius_km")]
    pub max_delivery_radius_km: f64,
    /// A sorted, deduplicated union of every available menu item's
    /// `dietary_tags`, maintained by `catalog_coordinator::add_menu_item`/
    /// `update_menu_item` (never set directly by a client) -- denormalized
    /// specifically so Browse can filter restaurants by dietary tag without
    /// fetching every candidate's full menu on every browse load. This
    /// moves the cost to the rare path (a merchant editing their menu)
    /// away from the hot one (a customer browsing), the same tradeoff
    /// `ledger`/`reputation`'s checkpoint mechanism makes for the opposite
    /// reason (architecture plan §9.4). Not independently verified in
    /// `validate()` -- recomputing "is this really the union of all this
    /// catalog's menu items" deterministically would need a non-deterministic
    /// `get_links` walk inside `validate()`, the same category of gap
    /// `order_total` already has (never independently re-derived either).
    #[serde(default)]
    pub dietary_tags: Vec<String>,
}

pub fn utc() -> String {
    "UTC".into()
}

pub const DEFAULT_PREP_MINUTES: u16 = 15;
/// No kitchen promises further out than this.
pub const MAX_PREP_MINUTES: u16 = 240;

fn default_prep_minutes() -> u16 {
    DEFAULT_PREP_MINUTES
}

fn default_delivery_subsidy_percent() -> u8 {
    50
}

pub fn default_max_delivery_radius_km() -> f64 {
    8.0
}

#[hdk_entry_helper]
#[derive(Clone)]
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

/// The longest a goodie bag may stay listed, creation to the end of its
/// pickup window. Bounding it is what lets every bag read query only the
/// last week of links instead of every bag a store has ever listed.
pub const MAX_GOODIE_BAG_LIFETIME_MICROS: i64 = 7 * 86_400 * 1_000_000;

/// How far a self-reported `created_at`/`claimed_at` may sit from its own
/// action's timestamp -- generous enough for clock skew, tight enough that
/// a bag can't be backdated out of (or forward-dated into) the listing
/// window above.
pub const CLOCK_SKEW_TOLERANCE_MICROS: i64 = 10 * 60 * 1_000_000;

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
    Confirmed,
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
pub struct BagClaim {
    pub bag_ref: ActionHash,
    pub customer: AgentPubKey,
    pub fulfillment: BagClaimFulfillment,
    pub status: BagClaimStatus,
    pub claimed_at: Timestamp,
}
