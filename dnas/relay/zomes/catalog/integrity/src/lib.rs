//! Integrity zome for merchant catalogs: `MerchantCatalog` (owner, location,
//! open/closed), `MenuItem` (must reference a real catalog), and `PromoCode`
//! (merchant-scoped discount codes).

use hdi::prelude::*;

// MerchantCatalog/MenuItem/PromoCode now live in catalog_types so
// dispatch_integrity can decode a PromoCode too, for its own promo-code
// validation in validate_new_order -- see that crate's doc comment for why
// a direct dependency on this crate wouldn't work. Re-exported here so
// nothing else in this crate or the coordinator crate (which imports via
// `catalog_integrity::*`) needs to change.
pub use catalog_types::{MenuItem, MerchantCatalog, PromoCode, PromoDiscount};

/// Precision used for the merchant-discovery anchor -- coarse (city-block
/// scale), matching the presence-beacon precision in `geo_presence` so both
/// discovery paths compose over the same geohash grid.
pub const CATALOG_GEOHASH_PRECISION: usize = 6;

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    MerchantCatalog(MerchantCatalog),
    MenuItem(MenuItem),
    PromoCode(PromoCode),
}

#[hdk_link_types]
pub enum LinkTypes {
    OwnerToCatalog,
    CatalogToMenuItem,
    GeohashToCatalog,
    CatalogToPromoCode,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::MerchantCatalog(catalog) => validate_catalog(&catalog, action.author()),
            EntryTypes::MenuItem(item) => validate_menu_item(&item, action.author()),
            EntryTypes::PromoCode(promo) => validate_new_promo_code(&promo, action.author()),
        },
        FlatOp::CreateEntry(OpEntry::UpdateEntry { app_entry, action }) => match app_entry {
            EntryTypes::MerchantCatalog(catalog) => validate_catalog(&catalog, action.author()),
            EntryTypes::MenuItem(item) => validate_menu_item(&item, action.author()),
            EntryTypes::PromoCode(promo) => validate_promo_code_update(&promo, action.author(), &action.original_action_address),
        },
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_catalog(catalog: &MerchantCatalog, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if catalog.business_name.trim().is_empty() {
        return Ok(ValidateCallbackResult::Invalid("business_name must not be empty".into()));
    }
    if &catalog.owner != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a merchant catalog can only be authored by its own owner".into(),
        ));
    }
    let expected = relay_types::encode(catalog.location, CATALOG_GEOHASH_PRECISION);
    if catalog.geohash != expected {
        return Ok(ValidateCallbackResult::Invalid(
            "geohash does not match the encoded location".into(),
        ));
    }
    if catalog.delivery_subsidy_percent > 100 {
        return Ok(ValidateCallbackResult::Invalid(
            "delivery_subsidy_percent must be between 0 and 100".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_menu_item(item: &MenuItem, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if item.name.trim().is_empty() {
        return Ok(ValidateCallbackResult::Invalid("name must not be empty".into()));
    }
    if item.price_cents == 0 {
        return Ok(ValidateCallbackResult::Invalid("price_cents must be greater than zero".into()));
    }
    // `catalog_ref` is always the catalog's *original* creation action
    // (set once at add_menu_item time, immutable thereafter), so
    // must_get_valid_record's literalness is exactly right here -- unlike
    // reading current status, "who owns this catalog" never changes after
    // creation, so the as-created record is the correct, and only,
    // reference point.
    let record = must_get_valid_record(item.catalog_ref.clone())?;
    let catalog: MerchantCatalog = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "catalog_ref does not point at a MerchantCatalog entry".into()
        )))?;
    if &catalog.owner != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a menu item can only be authored by its catalog's own owner".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn owner_of_catalog(catalog_ref: &ActionHash) -> ExternResult<AgentPubKey> {
    let record = must_get_valid_record(catalog_ref.clone())?;
    let catalog: MerchantCatalog = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "catalog_ref does not point at a MerchantCatalog entry".into()
        )))?;
    Ok(catalog.owner)
}

fn validate_discount(discount: &PromoDiscount) -> Option<&'static str> {
    match discount {
        PromoDiscount::PercentOff(p) if *p == 0 || *p > 100 => Some("PercentOff must be between 1 and 100"),
        PromoDiscount::FlatCentsOff(c) if *c == 0 => Some("FlatCentsOff must be greater than zero"),
        _ => None,
    }
}

fn validate_new_promo_code(promo: &PromoCode, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if promo.code.trim().is_empty() {
        return Ok(ValidateCallbackResult::Invalid("code must not be empty".into()));
    }
    if let Some(reason) = validate_discount(&promo.discount) {
        return Ok(ValidateCallbackResult::Invalid(reason.into()));
    }
    let owner = owner_of_catalog(&promo.catalog_ref)?;
    if &owner != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a promo code can only be authored by its catalog's own owner".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Only `active` may ever change -- `code`/`discount`/`catalog_ref`/
/// `expires_at`/`created_at` are fixed at creation, so a code's meaning
/// can't be silently altered out from under an order that already
/// referenced it (`dispatch_integrity::validate_new_order` resolves this
/// entry by reference, not by re-checking the discount amount separately).
fn validate_promo_code_update(promo: &PromoCode, author: &AgentPubKey, original_action_hash: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let owner = owner_of_catalog(&promo.catalog_ref)?;
    if &owner != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a promo code can only be updated by its catalog's own owner".into(),
        ));
    }
    let prior_record = must_get_valid_record(original_action_hash.clone())?;
    let prior: PromoCode = prior_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "original_action_hash does not point at a PromoCode entry".into()
        )))?;
    let unchanged = prior.catalog_ref == promo.catalog_ref
        && prior.code == promo.code
        && prior.discount == promo.discount
        && prior.expires_at == promo.expires_at
        && prior.created_at == promo.created_at;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "a promo code update may only change active -- every other field must stay the same".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}
