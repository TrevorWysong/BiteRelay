//! Integrity zome for merchant catalogs: `MerchantCatalog` (owner, location,
//! open/closed) and `MenuItem` (must reference a real catalog).

use hdi::prelude::*;
use relay_types::GeoPoint;

/// Precision used for the merchant-discovery anchor -- coarse (city-block
/// scale), matching the presence-beacon precision in `geo_presence` so both
/// discovery paths compose over the same geohash grid.
pub const CATALOG_GEOHASH_PRECISION: usize = 6;

#[hdk_entry_helper]
#[derive(Clone)]
pub struct MerchantCatalog {
    pub owner: AgentPubKey,
    pub business_name: String,
    pub location: GeoPoint,
    pub geohash: String,
    pub is_open: bool,
    /// Storefront depth added for the DoorDash/UberEats-style browse and
    /// detail views -- every field below defaults to empty on decode so
    /// existing catalog entries (and any client that hasn't caught up)
    /// still deserialize cleanly.
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub cuisine_type: String,
    /// A data URI, same reasoning as `Profile.avatar_data_uri` -- there is
    /// no image host in this system.
    #[serde(default)]
    pub banner_data_uri: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub address_line: String,
    /// Free-form "HH:MM" 24-hour strings, deliberately not a richer
    /// per-weekday schedule -- that's a real gap for a production app, but
    /// this is enough to show "open until 10pm" in the UI without a much
    /// larger struct for a demo.
    #[serde(default)]
    pub hours_open: String,
    #[serde(default)]
    pub hours_close: String,
    /// A deliberate promotional lever, not an expected split (architecture
    /// plan §12) -- how many cents of a winning bid's delivery fee this
    /// merchant covers, capped at the bid amount itself, computed
    /// deterministically at settlement (`dispatch::complete_delivery`).
    /// Defaults to 0, matching old-school independent delivery's norm of
    /// the fee being fully customer-paid unless a merchant opts to offer
    /// "free/discounted delivery" as a promotion.
    #[serde(default)]
    pub delivery_subsidy_cents: u64,
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
    /// Free-form section label ("Appetizers", "Mains", ...) -- the menu UI
    /// groups by whatever string is here, not a fixed enum, so a merchant
    /// can name sections however they want.
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub dietary_tags: Vec<String>,
}

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    MerchantCatalog(MerchantCatalog),
    MenuItem(MenuItem),
}

#[hdk_link_types]
pub enum LinkTypes {
    OwnerToCatalog,
    CatalogToMenuItem,
    GeohashToCatalog,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::MerchantCatalog(catalog) => validate_catalog(&catalog, action.author()),
            EntryTypes::MenuItem(item) => validate_menu_item(&item, action.author()),
        },
        FlatOp::CreateEntry(OpEntry::UpdateEntry { app_entry, action }) => match app_entry {
            EntryTypes::MerchantCatalog(catalog) => validate_catalog(&catalog, action.author()),
            EntryTypes::MenuItem(item) => validate_menu_item(&item, action.author()),
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
