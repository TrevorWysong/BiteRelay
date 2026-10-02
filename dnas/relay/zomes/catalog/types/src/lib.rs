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
    #[serde(default)]
    pub address_line: String,
    #[serde(default)]
    pub hours_open: String,
    #[serde(default)]
    pub hours_close: String,
    /// What share (0-100) of a winning bid's delivery fee this merchant
    /// covers -- see architecture plan §12 (2026-10-01 revision) for why
    /// this defaults to 50, not 0.
    #[serde(default = "default_delivery_subsidy_percent")]
    pub delivery_subsidy_percent: u8,
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

pub fn default_delivery_subsidy_percent() -> u8 {
    50
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
}
