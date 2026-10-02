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

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum PromoDiscount {
    /// 1-100 -- validated in `catalog_integrity::validate_promo_code`.
    PercentOff(u8),
    /// Cents, must be > 0.
    FlatCentsOff(u64),
}

/// Merchant-scoped, not global -- one restaurant's "WELCOME10" is a
/// completely independent code from another's, looked up by
/// `(catalog_ref, code)` rather than a globally unique string. Immutable
/// once created except `active` (see `catalog_coordinator::set_promo_code_active`)
/// -- a code's actual discount never changes after the fact, only whether
/// it can still be used.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct PromoCode {
    pub catalog_ref: ActionHash,
    pub code: String,
    pub discount: PromoDiscount,
    pub active: bool,
    pub expires_at: Option<Timestamp>,
    pub created_at: Timestamp,
}
