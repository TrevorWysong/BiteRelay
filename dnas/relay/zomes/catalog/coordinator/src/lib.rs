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

/// Resolves "does this agent already have a catalog" via the `OwnerToCatalog`
/// link created at publish time -- deterministic and independent of geohash
/// matching, unlike discovering it through `get_nearby_merchants` (which
/// only works if the caller's current `location` happens to hash to the
/// same cell the catalog itself did, and which has no stable tiebreak if
/// more than one link exists for the same owner). `publish_catalog` below
/// guards against ever creating more than one, but this picks the
/// newest-by-link-timestamp regardless, so a client that somehow already
/// has duplicates (e.g. from before that guard existed) still gets a
/// stable, repeatable answer instead of an arbitrary one each call.
#[hdk_extern]
pub fn get_my_catalog(_: ()) -> ExternResult<Option<Record>> {
    let owner = agent_info()?.agent_initial_pubkey;
    let mut links = get_links(LinkQuery::try_new(owner, LinkTypes::OwnerToCatalog)?, GetStrategy::default())?;
    links.sort_by_key(|l| l.timestamp);
    let Some(link) = links.pop() else { return Ok(None) };
    let Some(action_hash) = link.target.into_action_hash() else { return Ok(None) };
    Ok(Some(resolve_latest(action_hash)?))
}

#[hdk_extern]
pub fn publish_catalog(input: PublishCatalogInput) -> ExternResult<Record> {
    let owner = agent_info()?.agent_initial_pubkey;
    let existing = get_links(LinkQuery::try_new(owner.clone(), LinkTypes::OwnerToCatalog)?, GetStrategy::default())?;
    if !existing.is_empty() {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "You already have a published storefront -- there's no second one to create.".into()
        )));
    }
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
        delivery_subsidy_percent: 50,
        dietary_tags: Vec::new(),
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

/// Cross-zome read for `dispatch::complete_delivery` (and the equivalent
/// dispute-resolution settlement paths) to look up a merchant's current
/// `delivery_subsidy_percent` at settlement time -- no client previously
/// needed to fetch a single catalog by reference, only lists/pages.
#[hdk_extern]
pub fn get_catalog(catalog_ref: ActionHash) -> ExternResult<Record> {
    resolve_latest(catalog_ref)
}

/// A narrow, purpose-built cross-zome read for `dispatch::complete_delivery`
/// -- returns just the one field settlement needs, rather than having
/// `dispatch_coordinator` partially-decode a `MerchantCatalog` entry it has
/// no Cargo-level type for (coordinator zomes call each other over the
/// zome-call boundary specifically to avoid that kind of coupling; see
/// `dispatch_coordinator::matching::NearbyProviderView`'s doc comment for
/// the same reasoning applied to `geo_presence`).
#[hdk_extern]
pub fn get_delivery_subsidy(catalog_ref: ActionHash) -> ExternResult<u8> {
    let record = resolve_latest(catalog_ref)?;
    let catalog: MerchantCatalog = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a MerchantCatalog".into())))?;
    Ok(catalog.delivery_subsidy_percent)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetDeliverySubsidyPercentInput {
    pub original_action: ActionHash,
    pub delivery_subsidy_percent: u8,
}

/// The standard delivery-cost-sharing model (architecture plan §12,
/// 2026-10-01 revision), not a rare promotion -- defaults to 50 (an even
/// split with the customer) at `publish_catalog` time, adjustable here if a
/// merchant needs a different split. A percentage, not a flat amount, so
/// it stays proportional to whatever the winning bid turns out to be.
#[hdk_extern]
pub fn set_delivery_subsidy_percent(input: SetDeliverySubsidyPercentInput) -> ExternResult<Record> {
    let record = resolve_latest(input.original_action)?;
    let mut catalog: MerchantCatalog = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a MerchantCatalog".into())))?;
    catalog.delivery_subsidy_percent = input.delivery_subsidy_percent;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::MerchantCatalog(catalog))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back updated catalog".into())))
}

/// Recomputes `MerchantCatalog.dietary_tags` as the sorted, deduplicated
/// union of every one of this catalog's menu items' own `dietary_tags` --
/// called after any menu-item create/update so the denormalized field
/// never drifts from the real per-item data. Walks every page rather than
/// just the first: a merchant's menu is realistically a few dozen items at
/// most (this is a write-time-only cost, paid on menu edits, not on every
/// browse read -- see `MerchantCatalog.dietary_tags`'s own doc comment for
/// why that tradeoff is the right one here), but silently truncating at one
/// page would mean an item on page 2 could never contribute its tags.
fn recompute_dietary_tags(catalog_ref: &ActionHash) -> ExternResult<()> {
    let mut tags: Vec<String> = Vec::new();
    let mut after = None;
    loop {
        let page = list_menu_items(ListMenuItemsInput { catalog_ref: catalog_ref.clone(), after })?;
        for record in &page.items {
            if let Ok(Some(item)) = record.entry().to_app_option::<MenuItem>() {
                tags.extend(item.dietary_tags);
            }
        }
        after = page.next_after;
        if after.is_none() {
            break;
        }
    }
    tags.sort();
    tags.dedup();

    let catalog_record = resolve_latest(catalog_ref.clone())?;
    let mut catalog: MerchantCatalog = catalog_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("catalog_ref does not point at a MerchantCatalog".into())))?;
    if catalog.dietary_tags != tags {
        catalog.dietary_tags = tags;
        update_entry(catalog_record.action_address().clone(), &EntryTypes::MerchantCatalog(catalog))?;
    }
    Ok(())
}

#[hdk_extern]
pub fn add_menu_item(item: MenuItem) -> ExternResult<Record> {
    let catalog_ref = item.catalog_ref.clone();
    let action_hash = create_entry(&EntryTypes::MenuItem(item.clone()))?;
    create_link(catalog_ref.clone(), action_hash.clone(), LinkTypes::CatalogToMenuItem, ())?;
    recompute_dietary_tags(&catalog_ref)?;
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
    let catalog_ref = input.item.catalog_ref.clone();
    let updated = update_entry(record.action_address().clone(), &EntryTypes::MenuItem(input.item))?;
    recompute_dietary_tags(&catalog_ref)?;
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

// --- promo codes (architecture plan: merchant-scoped discounts, built
// 2026-10-02 alongside the delivery-fee-sharing work) ---

fn promo_anchor_path(catalog_ref: &ActionHash) -> ExternResult<hdi::hash_path::path::TypedPath> {
    Path::from(format!("catalog_promo.{}", catalog_ref)).typed(LinkTypes::CatalogToPromoCode)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CreatePromoCodeInput {
    pub catalog_ref: ActionHash,
    pub code: String,
    pub requirement: PromoRequirement,
    pub reward: PromoReward,
    pub expires_at: Option<Timestamp>,
    #[serde(default)]
    pub auto_apply: bool,
}

/// Cross-zome read for `dispatch::request_delivery`'s best-effort "is this
/// code still active" pre-check -- `resolve_latest` (unlike `hdi`'s
/// `must_get_valid_record`, which the deterministic `validate()` side has
/// to use and which is always literal) actually walks to the current
/// state, so this is the one place that question can genuinely be
/// answered. See `dispatch_integrity::validate_new_order`'s own doc
/// comment for why `active` specifically can't be enforced there.
#[hdk_extern]
pub fn get_promo_code(promo_ref: ActionHash) -> ExternResult<Record> {
    resolve_latest(promo_ref)
}

#[hdk_extern]
pub fn create_promo_code(input: CreatePromoCodeInput) -> ExternResult<Record> {
    let promo = PromoCode {
        catalog_ref: input.catalog_ref.clone(),
        code: input.code,
        requirement: input.requirement,
        reward: input.reward,
        active: true,
        expires_at: input.expires_at,
        created_at: sys_time()?,
        auto_apply: input.auto_apply,
    };
    let action_hash = create_entry(&EntryTypes::PromoCode(promo))?;
    let path = promo_anchor_path(&input.catalog_ref)?;
    path.ensure()?;
    create_link(path.path_entry_hash()?, action_hash.clone(), LinkTypes::CatalogToPromoCode, ())?;
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back promo code".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetPromoCodeActiveInput {
    pub original_action: ActionHash,
    pub active: bool,
}

#[hdk_extern]
pub fn set_promo_code_active(input: SetPromoCodeActiveInput) -> ExternResult<Record> {
    let record = resolve_latest(input.original_action)?;
    let mut promo: PromoCode = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a PromoCode".into())))?;
    promo.active = input.active;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::PromoCode(promo))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back updated promo code".into())))
}

/// Small, bounded link set per merchant (a handful of codes at most), so no
/// pagination -- reused for both the merchant's own management view and a
/// customer's redemption lookup (match the typed code client-side against
/// this list, same approach `list_menu_items` + client-side filtering
/// already uses elsewhere rather than a dedicated per-code index).
#[hdk_extern]
pub fn list_promo_codes_for_catalog(catalog_ref: ActionHash) -> ExternResult<Vec<Record>> {
    let path = promo_anchor_path(&catalog_ref)?;
    let path_hash = match path.path_entry_hash() {
        Ok(hash) => hash,
        Err(_) => return Ok(Vec::new()),
    };
    let links = get_links(LinkQuery::try_new(path_hash, LinkTypes::CatalogToPromoCode)?, GetStrategy::default())?;
    let mut promos = Vec::with_capacity(links.len());
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if let Ok(record) = resolve_latest(action_hash) {
            promos.push(record);
        }
    }
    Ok(promos)
}
