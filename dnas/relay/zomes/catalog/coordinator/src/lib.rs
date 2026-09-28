//! Coordinator zome for merchant catalogs: publishing a catalog, toggling
//! it open/closed, adding menu items, and geohash-anchor discovery
//! ("restaurants near me") -- the same anchor pattern `geo_presence` uses
//! for provider beacons.

use catalog_integrity::*;
use hdi::hash_path::path::Path;
use hdk::prelude::*;
use relay_coordinator_support::{next_page_cursor, resolve_latest};
use relay_types::GeoPoint;

fn geohash_anchor_path(geohash: &str) -> ExternResult<hdi::hash_path::path::TypedPath> {
    Path::from(format!("catalog_geohash.{}", geohash)).typed(LinkTypes::GeohashToCatalog)
}

/// Unlike presence beacons and open orders (architecture plan §9.2), old
/// catalog entries are *signal*, not noise -- a merchant published a year
/// ago should still show up in "restaurants near me" today, so this anchor
/// is deliberately *not* time-bucketed. The real scale concern here is
/// different: a dense city can legitimately have thousands of real
/// merchants in one cell, and returning all of them in one call doesn't
/// bound payload size or per-call cost. Fixed with pagination instead (§9.3).
const CATALOG_PAGE_SIZE: usize = 50;
const MENU_ITEM_PAGE_SIZE: usize = 50;

#[derive(Serialize, Deserialize, Debug)]
pub struct PublishCatalogInput {
    pub business_name: String,
    pub location: GeoPoint,
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
}

#[hdk_extern]
pub fn publish_catalog(input: PublishCatalogInput) -> ExternResult<Record> {
    let owner = agent_info()?.agent_initial_pubkey;
    let geohash = relay_types::encode(input.location, CATALOG_GEOHASH_PRECISION);
    let catalog = MerchantCatalog {
        owner: owner.clone(),
        business_name: input.business_name,
        location: input.location,
        geohash: geohash.clone(),
        is_open: true,
        description: input.description,
        cuisine_type: input.cuisine_type,
        banner_data_uri: input.banner_data_uri,
        phone: input.phone,
        address_line: input.address_line,
        hours_open: input.hours_open,
        hours_close: input.hours_close,
    };
    let action_hash = create_entry(&EntryTypes::MerchantCatalog(catalog))?;
    create_link(owner, action_hash.clone(), LinkTypes::OwnerToCatalog, ())?;

    let path = geohash_anchor_path(&geohash)?;
    path.ensure()?;
    create_link(
        path.path_entry_hash()?,
        action_hash.clone(),
        LinkTypes::GeohashToCatalog,
        (),
    )?;

    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back published catalog".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetCatalogOpenInput {
    pub original_action: ActionHash,
    pub is_open: bool,
}

#[hdk_extern]
pub fn set_catalog_open(input: SetCatalogOpenInput) -> ExternResult<Record> {
    let record = resolve_latest(input.original_action)?;
    let mut catalog: MerchantCatalog = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a MerchantCatalog".into())))?;
    catalog.is_open = input.is_open;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::MerchantCatalog(catalog))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back updated catalog".into())))
}

/// A merchant fills in storefront depth (description, cuisine, hours,
/// banner) incrementally after publishing, not necessarily all at once --
/// this is the one editable surface for everything `publish_catalog` sets
/// besides `business_name`/`location` (changing those would drift the
/// entry's own `geohash` invariant, so they stay immutable after creation).
#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateCatalogDetailsInput {
    pub original_action: ActionHash,
    pub description: String,
    pub cuisine_type: String,
    pub banner_data_uri: String,
    pub phone: String,
    pub address_line: String,
    pub hours_open: String,
    pub hours_close: String,
}

#[hdk_extern]
pub fn update_catalog_details(input: UpdateCatalogDetailsInput) -> ExternResult<Record> {
    let record = resolve_latest(input.original_action)?;
    let mut catalog: MerchantCatalog = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a MerchantCatalog".into())))?;
    catalog.description = input.description;
    catalog.cuisine_type = input.cuisine_type;
    catalog.banner_data_uri = input.banner_data_uri;
    catalog.phone = input.phone;
    catalog.address_line = input.address_line;
    catalog.hours_open = input.hours_open;
    catalog.hours_close = input.hours_close;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::MerchantCatalog(catalog))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back updated catalog".into())))
}

#[hdk_extern]
pub fn add_menu_item(item: MenuItem) -> ExternResult<Record> {
    let action_hash = create_entry(&EntryTypes::MenuItem(item.clone()))?;
    create_link(item.catalog_ref, action_hash.clone(), LinkTypes::CatalogToMenuItem, ())?;
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back menu item".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateMenuItemInput {
    pub original_action: ActionHash,
    pub item: MenuItem,
}

#[hdk_extern]
pub fn update_menu_item(input: UpdateMenuItemInput) -> ExternResult<Record> {
    let record = resolve_latest(input.original_action)?;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::MenuItem(input.item))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back updated menu item".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ListMenuItemsInput {
    pub catalog_ref: ActionHash,
    /// Page cursor -- pass back the previous call's `next_after` to continue.
    /// `None` starts from the beginning.
    pub after: Option<Timestamp>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MenuItemsPage {
    pub items: Vec<Record>,
    pub next_after: Option<Timestamp>,
}

#[hdk_extern]
pub fn list_menu_items(input: ListMenuItemsInput) -> ExternResult<MenuItemsPage> {
    let mut query = LinkQuery::try_new(input.catalog_ref, LinkTypes::CatalogToMenuItem)?;
    query.after = input.after;
    let mut links = get_links(query, GetStrategy::default())?;
    links.sort_by_key(|l| l.timestamp);
    let next_after = if links.len() > MENU_ITEM_PAGE_SIZE {
        Some(next_page_cursor(links[MENU_ITEM_PAGE_SIZE - 1].timestamp))
    } else {
        None
    };
    links.truncate(MENU_ITEM_PAGE_SIZE);
    let mut items = Vec::with_capacity(links.len());
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if let Ok(record) = resolve_latest(action_hash) {
            items.push(record);
        }
    }
    Ok(MenuItemsPage { items, next_after })
}

#[derive(Serialize, Deserialize, Debug)]
pub struct NearbyMerchantsInput {
    pub geohash: String,
    /// Page cursor -- pass back the previous call's `next_after` to continue.
    /// `None` starts from the beginning.
    pub after: Option<Timestamp>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct NearbyMerchantsPage {
    pub catalogs: Vec<Record>,
    pub next_after: Option<Timestamp>,
}

/// Returns merchant catalogs declared in `geohash`'s cell and its 8
/// neighbors -- the same discovery pattern `geo_presence` uses for provider
/// beacons, so restaurant browsing and driver discovery compose over one
/// grid. Paginated (architecture plan §9.3), not time-bucketed like
/// presence/open-order discovery -- old catalogs are signal here, not noise,
/// so bucketing would just mean re-linking every merchant forever instead
/// of fixing anything. `after` filtering happens per-cell before the
/// cross-cell merge below, so it also reduces per-cell payload size, not
/// just the final page.
#[hdk_extern]
pub fn get_nearby_merchants(input: NearbyMerchantsInput) -> ExternResult<NearbyMerchantsPage> {
    let mut links = Vec::new();
    for cell in relay_types::cell_and_neighbors(&input.geohash) {
        let path = geohash_anchor_path(&cell)?;
        let path_hash = match path.path_entry_hash() {
            Ok(hash) => hash,
            Err(_) => continue,
        };
        let mut query = LinkQuery::try_new(path_hash, LinkTypes::GeohashToCatalog)?;
        query.after = input.after;
        links.extend(get_links(query, GetStrategy::default())?);
    }
    links.sort_by_key(|l| l.timestamp);
    let next_after = if links.len() > CATALOG_PAGE_SIZE {
        Some(next_page_cursor(links[CATALOG_PAGE_SIZE - 1].timestamp))
    } else {
        None
    };
    links.truncate(CATALOG_PAGE_SIZE);
    let mut catalogs = Vec::new();
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if let Ok(record) = resolve_latest(action_hash) {
            catalogs.push(record);
        }
    }
    Ok(NearbyMerchantsPage { catalogs, next_after })
}
