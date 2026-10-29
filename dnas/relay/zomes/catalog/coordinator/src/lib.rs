//! Coordinator zome for merchant catalogs: publishing a catalog, toggling
//! it open/closed, adding menu items, goodie bags and their claims
//! (`bags`), and geohash-anchor discovery ("restaurants near me") -- the
//! same anchor pattern drivers use to find open orders.

mod bags;
mod modifiers;
mod moves;
mod signals;
pub use bags::*;
pub use modifiers::*;
pub use moves::*;
pub use signals::*;

use catalog_integrity::*;
use hdi::hash_path::path::Path;
use hdk::prelude::*;
use relay_coordinator_support::chain::{my_current_version, my_versions};
use relay_coordinator_support::{decode_or, guest, next_page_cursor, resolve_latest, resolve_latest_decoded, resolve_links_to_records_with_original, resolve_version, resolve_version_decoded, update_version, written};
use relay_types::GeoPoint;

fn geohash_anchor_path(geohash: &str) -> ExternResult<hdi::hash_path::path::TypedPath> {
    Path::from(catalog_geohash_path(geohash)).typed(LinkTypes::GeohashToCatalog)
}

/// Unlike open orders, old
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
    pub address_street: String,
    #[serde(default)]
    pub address_city: String,
    #[serde(default)]
    pub address_state: String,
    #[serde(default)]
    pub address_zip: String,
    /// See `MerchantCatalog::weekly_hours`.
    #[serde(default)]
    pub weekly_hours: Vec<OpeningPeriod>,
    /// The merchant's IANA time zone -- the app sends the device's; UTC if
    /// left out.
    #[serde(default = "utc")]
    pub time_zone: String,
    /// The network's default (`relay_governance::default_prep_minutes`) if
    /// left out.
    #[serde(default)]
    pub prep_minutes: Option<u16>,
    /// The network's default (`relay_governance::default_delivery_radius_km`)
    /// if left out.
    #[serde(default)]
    pub max_delivery_radius_km: Option<f64>,
}

fn utc() -> String {
    "UTC".into()
}

/// A catalog's stable identity alongside its current content. Everything
/// tied to a store (menu items, promo codes, goodie bags, order queues,
/// reviews) is keyed on its *original* action, while screens need its
/// *latest* state (open right now? current subsidy?) -- and a `Record`'s
/// own hash is only ever one of the two.
#[derive(Serialize, Deserialize, Debug)]
pub struct CatalogView {
    /// The catalog's original action -- the `OwnerToCatalog`/
    /// `GeohashToCatalog` link target, fixed at publish time. Use this as
    /// `catalog_ref`, never the record's own hash, which changes on every
    /// edit (and would orphan everything keyed on the store).
    pub original_action: ActionHash,
    pub record: Record,
}

/// Every store this agent owns, oldest first, via the `OwnerToCatalog`
/// links created at publish time -- deterministic and independent of
/// geohash matching, unlike discovering them through `get_nearby_merchants`
/// (which only works if the caller's current `location` happens to hash to
/// the same cell each store did). One owner running several stores is the
/// normal case, not an edge case -- same as one DoorDash/Uber Eats business
/// login managing several locations -- so everything per-store (menu,
/// promo codes, goodie bags, order queue, reviews, reputation) is keyed by
/// each store's own `original_action`, never by the owner. Creation order
/// is the stable ordering a store switcher wants: a newly added store
/// lands at the end instead of reshuffling the list.
#[hdk_extern]
pub fn list_my_catalogs(_: ()) -> ExternResult<Vec<CatalogView>> {
    let owner = agent_info()?.agent_initial_pubkey;
    let mut links = get_links(LinkQuery::try_new(owner, LinkTypes::OwnerToCatalog)?, GetStrategy::default())?;
    links.sort_by_key(|l| l.timestamp);
    Ok(resolve_links_to_records_with_original(links)
        .into_iter()
        .map(|(original_action, record)| CatalogView { original_action, record })
        .collect())
}

/// Publishes a new store. Deliberately no "you already have one" guard --
/// an owner adds as many stores as they run (see `list_my_catalogs`).
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
        address_street: input.address_street,
        address_city: input.address_city,
        address_state: input.address_state,
        address_zip: input.address_zip,
        weekly_hours: input.weekly_hours,
        time_zone: input.time_zone,
        prep_minutes: input.prep_minutes.unwrap_or_else(relay_governance::default_prep_minutes),
        delivery_subsidy_percent: relay_governance::default_delivery_subsidy_percent(),
        max_delivery_radius_km: input.max_delivery_radius_km.unwrap_or_else(relay_governance::default_delivery_radius_km),
        dietary_tags: Vec::new(),
        auto_accept_orders: false,
        leave_at_door_max_cents: None,
        min_order_cents: None,
        busy_extra_minutes: 0,
        store_wait_minutes: None,
        tax_rates: Vec::new(),
        prices_include_tax: false,
        tax_registration: String::new(),
    };
    let action_hash = create_entry(&EntryTypes::MerchantCatalog(catalog))?;
    create_link(owner, action_hash.clone(), LinkTypes::OwnerToCatalog, ())?;

    list(&action_hash, &geohash)?;

    written(action_hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetCatalogOpenInput {
    pub original_action: ActionHash,
    pub is_open: bool,
}

#[hdk_extern]
pub fn set_catalog_open(input: SetCatalogOpenInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.is_open = input.is_open;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetAutoAcceptOrdersInput {
    pub original_action: ActionHash,
    pub auto_accept_orders: bool,
}

/// Turns the store's conductor accepting new orders on its own on or off --
/// see `MerchantCatalog::auto_accept_orders`.
#[hdk_extern]
pub fn set_auto_accept_orders(input: SetAutoAcceptOrdersInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.auto_accept_orders = input.auto_accept_orders;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetLeaveAtDoorLimitInput {
    pub original_action: ActionHash,
    /// `None` for no limit.
    pub max_cents: Option<u64>,
}

/// The most an order may cost to be left at the door -- see
/// `MerchantCatalog::leave_at_door_max_cents`.
#[hdk_extern]
pub fn set_leave_at_door_limit(input: SetLeaveAtDoorLimitInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.leave_at_door_max_cents = input.max_cents;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetMinimumOrderInput {
    pub original_action: ActionHash,
    /// `None` for any size.
    pub min_cents: Option<u64>,
}

/// The smallest order the store takes -- see
/// `MerchantCatalog::min_order_cents`.
#[hdk_extern]
pub fn set_minimum_order(input: SetMinimumOrderInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.min_order_cents = input.min_cents;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetTaxSettingsInput {
    pub original_action: ActionHash,
    pub tax_rates: Vec<TaxRate>,
    pub prices_include_tax: bool,
    pub tax_registration: String,
}

/// The sales tax or VAT the store charges -- see `MerchantCatalog::tax_rates`.
/// Orders placed from here on are taxed at these rates; earlier ones keep
/// the rates they were placed under.
#[hdk_extern]
pub fn set_tax_settings(input: SetTaxSettingsInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.tax_rates = input.tax_rates;
    catalog.prices_include_tax = input.prices_include_tax;
    catalog.tax_registration = input.tax_registration.trim().to_string();
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetStoreWaitInput {
    pub original_action: ActionHash,
    /// `None` for the network's.
    pub minutes: Option<u16>,
}

/// How long the store may keep a checked-in driver waiting past an order's
/// ready time -- see `MerchantCatalog::store_wait_minutes`. Orders keep the
/// wait they were placed under.
#[hdk_extern]
pub fn set_store_wait(input: SetStoreWaitInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.store_wait_minutes = input.minutes;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetBusyInput {
    pub original_action: ActionHash,
    /// Minutes to add to the usual prep time; 0 when the rush is over.
    pub extra_minutes: u16,
}

/// The store saying it's busy (or not any more) -- see
/// `MerchantCatalog::busy_extra_minutes`.
#[hdk_extern]
pub fn set_busy(input: SetBusyInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.busy_extra_minutes = input.extra_minutes;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
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
    pub address_street: String,
    pub address_city: String,
    pub address_state: String,
    pub address_zip: String,
    /// See `MerchantCatalog::weekly_hours`.
    pub weekly_hours: Vec<OpeningPeriod>,
    /// The merchant's IANA time zone, from their device.
    pub time_zone: String,
    pub prep_minutes: u16,
    pub max_delivery_radius_km: f64,
}

#[hdk_extern]
pub fn update_catalog_details(input: UpdateCatalogDetailsInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.description = input.description;
    catalog.cuisine_type = input.cuisine_type;
    catalog.banner_data_uri = input.banner_data_uri;
    catalog.phone = input.phone;
    catalog.address_street = input.address_street;
    catalog.address_city = input.address_city;
    catalog.address_state = input.address_state;
    catalog.address_zip = input.address_zip;
    catalog.weekly_hours = input.weekly_hours;
    catalog.time_zone = input.time_zone;
    catalog.prep_minutes = input.prep_minutes;
    catalog.max_delivery_radius_km = input.max_delivery_radius_km;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
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
/// zome-call boundary specifically to avoid that kind of coupling).
#[hdk_extern]
pub fn get_delivery_subsidy(catalog_ref: ActionHash) -> ExternResult<u8> {
    let (_, catalog): (_, MerchantCatalog) = resolve_latest_decoded(catalog_ref, "MerchantCatalog")?;
    Ok(catalog.delivery_subsidy_percent)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetDeliverySubsidyPercentInput {
    pub original_action: ActionHash,
    pub delivery_subsidy_percent: u8,
}

/// The standard delivery-cost-sharing model, not a rare promotion --
/// defaults to 50 (an even
/// split with the customer) at `publish_catalog` time, adjustable here if a
/// merchant needs a different split. A percentage, not a flat amount, so
/// it stays proportional to whatever the winning bid turns out to be.
#[hdk_extern]
pub fn set_delivery_subsidy_percent(input: SetDeliverySubsidyPercentInput) -> ExternResult<Record> {
    let (current, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(input.original_action, "MerchantCatalog")?;
    catalog.delivery_subsidy_percent = input.delivery_subsidy_percent;
    let updated = update_version(&current, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    written(updated)
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
pub(crate) fn recompute_dietary_tags(catalog_ref: &ActionHash) -> ExternResult<()> {
    let mut tags: Vec<String> = Vec::new();
    let mut after = None;
    loop {
        let page = list_menu_items(ListMenuItemsInput { catalog_ref: catalog_ref.clone(), after })?;
        for view in &page.items {
            if let Ok(Some(item)) = view.record.entry().to_app_option::<MenuItem>() {
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

    let (catalog_record, mut catalog): (_, MerchantCatalog) = resolve_version_decoded(catalog_ref.clone(), "MerchantCatalog")?;
    if catalog.dietary_tags != tags {
        catalog.dietary_tags = tags;
        update_version(&catalog_record, &EntryTypes::MerchantCatalog(catalog), LinkTypes::Version)?;
    }
    Ok(())
}

#[hdk_extern]
pub fn add_menu_item(item: MenuItem) -> ExternResult<Record> {
    let catalog_ref = item.catalog_ref.clone();
    let action_hash = create_entry(&EntryTypes::MenuItem(item.clone()))?;
    create_link(catalog_ref.clone(), action_hash.clone(), LinkTypes::CatalogToMenuItem, ())?;
    recompute_dietary_tags(&catalog_ref)?;
    written(action_hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateMenuItemInput {
    pub original_action: ActionHash,
    pub item: MenuItem,
}

#[hdk_extern]
pub fn update_menu_item(input: UpdateMenuItemInput) -> ExternResult<Record> {
    // Built on the caller's own latest version, which this device always
    // has: building on an older one would fork the item's history.
    let current = match my_current_version(input.original_action.clone())? {
        Some(current) => current,
        None => resolve_version(input.original_action)?,
    };
    let catalog_ref = input.item.catalog_ref.clone();
    let updated = update_version(&current, &EntryTypes::MenuItem(input.item), LinkTypes::Version)?;
    recompute_dietary_tags(&catalog_ref)?;
    written(updated)
}

/// One version of a menu item (or a choice group): the action that wrote
/// it, and when.
#[derive(Serialize, Deserialize, Debug)]
pub struct ItemVersion {
    pub action: ActionHash,
    pub written_at: Timestamp,
}

/// A menu item's name now, and every version of it, oldest first.
#[derive(Serialize, Deserialize, Debug)]
pub struct ItemVersions {
    pub item_ref: ActionHash,
    pub name: String,
    pub versions: Vec<ItemVersion>,
}

/// Every version of each of the caller's own menu items, from their source
/// chain -- complete and current, unlike a DHT read, since the caller wrote
/// each one. What a store checks an order's prices against (see
/// `dispatch::pricing::outdated_item`). An item the caller didn't write
/// comes back with no versions.
#[hdk_extern]
pub fn get_my_item_versions(item_refs: Vec<ActionHash>) -> ExternResult<Vec<ItemVersions>> {
    item_refs
        .into_iter()
        .map(|item_ref| {
            let versions = my_versions(item_ref.clone())?;
            let name = versions.last().and_then(|r| r.entry().to_app_option::<MenuItem>().ok().flatten()).map(|item| item.name).unwrap_or_default();
            let versions = versions.iter().map(|r| ItemVersion { action: r.action_address().clone(), written_at: r.action().timestamp() }).collect();
            Ok(ItemVersions { item_ref, name, versions })
        })
        .collect()
}

/// Every version of one of the caller's own stores, oldest first, from their
/// source chain -- what a store checks the terms an order cites against
/// (`dispatch::pricing::terms_outdated`). Empty if the caller didn't write it.
#[hdk_extern]
pub fn get_my_store_versions(catalog_ref: ActionHash) -> ExternResult<Vec<ItemVersion>> {
    Ok(my_versions(catalog_ref)?.iter().map(|r| ItemVersion { action: r.action_address().clone(), written_at: r.action().timestamp() }).collect())
}

/// One version of a promo code, as a store checks an order's promo against
/// it.
#[derive(Serialize, Deserialize, Debug)]
pub struct PromoVersion {
    pub active: bool,
    pub expires_at: Option<Timestamp>,
    pub written_at: Timestamp,
}

/// Every version of one of the caller's own promo codes, oldest first, from
/// their source chain -- what a store checks an order's promo against
/// before accepting it (`dispatch::pricing::outdated_item`). Empty if the
/// caller didn't write it.
#[hdk_extern]
pub fn get_my_promo_versions(promo_ref: ActionHash) -> ExternResult<Vec<PromoVersion>> {
    Ok(my_versions(promo_ref)?
        .iter()
        .filter_map(|record| {
            let promo = record.entry().to_app_option::<PromoCode>().ok().flatten()?;
            Some(PromoVersion { active: promo.active, expires_at: promo.expires_at, written_at: record.action().timestamp() })
        })
        .collect())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ListMenuItemsInput {
    pub catalog_ref: ActionHash,
    /// Page cursor -- pass back the previous call's `next_after` to continue.
    /// `None` starts from the beginning.
    pub after: Option<Timestamp>,
}

/// A menu item's stable identity (its original action -- what orders,
/// carts, promos and item reviews reference) alongside its latest content.
/// The latest record's own hash changes on every edit, even toggling it
/// sold out, so it can't be the identity -- see `CatalogView`.
#[derive(Serialize, Deserialize, Debug)]
pub struct MenuItemView {
    pub original_action: ActionHash,
    pub record: Record,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MenuItemsPage {
    pub items: Vec<MenuItemView>,
    pub next_after: Option<Timestamp>,
}

#[hdk_extern]
pub fn list_menu_items(input: ListMenuItemsInput) -> ExternResult<MenuItemsPage> {
    let mut query = LinkQuery::try_new(input.catalog_ref.clone(), LinkTypes::CatalogToMenuItem)?;
    query.after = input.after;
    let mut links = get_links(query, GetStrategy::default())?;
    links.sort_by_key(|l| l.timestamp);
    let next_after = if links.len() > MENU_ITEM_PAGE_SIZE {
        Some(next_page_cursor(links[MENU_ITEM_PAGE_SIZE - 1].timestamp))
    } else {
        None
    };
    links.truncate(MENU_ITEM_PAGE_SIZE);
    // Link validation already guarantees this; checking again keeps a menu
    // honest even if that guarantee ever regressed.
    let items = resolve_links_to_records_with_original(links)
        .into_iter()
        .filter(|(_, record)| decode_or::<MenuItem>(record).is_some_and(|item| item.catalog_ref == input.catalog_ref))
        .map(|(original_action, record)| MenuItemView { original_action, record })
        .collect();
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
    pub catalogs: Vec<CatalogView>,
    pub next_after: Option<Timestamp>,
}

/// Returns merchant catalogs declared in `geohash`'s cell and its 8
/// neighbors -- the same discovery pattern drivers use for open orders, so
/// restaurant browsing and order discovery compose over one grid. Paginated,
/// not time-bucketed like open-order discovery -- old catalogs are signal here, not noise,
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
    for (original_action, record) in resolve_links_to_records_with_original(links) {
        // A store whose owner moved it to a new key shows as the new one.
        if !moves::has_moved(&original_action)? {
            catalogs.push(CatalogView { original_action, record });
        }
    }
    Ok(NearbyMerchantsPage { catalogs, next_after })
}

// --- promo codes: a store's own discounts ---


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
    create_link(input.catalog_ref.clone(), action_hash.clone(), LinkTypes::CatalogToPromoCode, ())?;
    create_link(input.catalog_ref, action_hash.clone(), LinkTypes::CatalogToLivePromo, ())?;
    written(action_hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetPromoCodeActiveInput {
    pub original_action: ActionHash,
    pub active: bool,
}

#[hdk_extern]
pub fn set_promo_code_active(input: SetPromoCodeActiveInput) -> ExternResult<Record> {
    let (current, mut promo): (_, PromoCode) = resolve_version_decoded(input.original_action.clone(), "PromoCode")?;
    let catalog_ref = promo.catalog_ref.clone();
    promo.active = input.active;
    let updated = update_version(&current, &EntryTypes::PromoCode(promo), LinkTypes::Version)?;
    let target: AnyLinkableHash = input.original_action.clone().into();
    let live_links: Vec<Link> = get_links(LinkQuery::try_new(catalog_ref.clone(), LinkTypes::CatalogToLivePromo)?, GetStrategy::default())?
        .into_iter()
        .filter(|link| link.target == target)
        .collect();
    if input.active && live_links.is_empty() {
        create_link(catalog_ref, input.original_action, LinkTypes::CatalogToLivePromo, ())?;
    } else if !input.active {
        for link in live_links {
            delete_link(link.create_link_hash, GetOptions::default())?;
        }
    }
    written(updated)
}

/// A promo code's stable identity (what orders and `set_promo_code_active`
/// take) alongside its latest state -- see `CatalogView`.
#[derive(Serialize, Deserialize, Debug)]
pub struct PromoView {
    pub original_action: ActionHash,
    pub record: Record,
}

fn promo_views(catalog_ref: &ActionHash, links: Vec<Link>) -> Vec<PromoView> {
    resolve_links_to_records_with_original(links)
        .into_iter()
        .filter(|(_, record)| decode_or::<PromoCode>(record).is_some_and(|promo| &promo.catalog_ref == catalog_ref))
        .map(|(original_action, record)| PromoView { original_action, record })
        .collect()
}

/// The codes a customer can use at this store right now (active, not
/// expired) -- what checkout matches a typed code against and picks
/// auto-apply deals from. Reads only the live index, so its cost is the
/// store's current deals, not every code it ever ran.
#[hdk_extern]
pub fn list_live_promo_codes(catalog_ref: ActionHash) -> ExternResult<Vec<PromoView>> {
    let now = sys_time()?;
    let links = get_links(LinkQuery::try_new(catalog_ref.clone(), LinkTypes::CatalogToLivePromo)?, GetStrategy::default())?;
    Ok(promo_views(&catalog_ref, links)
        .into_iter()
        .filter(|view| decode_or::<PromoCode>(&view.record).is_some_and(|promo| promo.active && promo.expires_at.is_none_or(|expires| expires > now)))
        .collect())
}

const PROMO_PAGE_SIZE: usize = 25;

#[derive(Serialize, Deserialize, Debug)]
pub struct ListPromoCodesInput {
    pub catalog_ref: ActionHash,
    /// Page cursor -- the previous page's `next_before`. `None` starts from
    /// the newest code.
    pub before: Option<Timestamp>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PromoCodesPage {
    pub promo_codes: Vec<PromoView>,
    pub next_before: Option<Timestamp>,
}

/// Every code the store has created, active or not, newest first -- the
/// merchant's management list.
#[hdk_extern]
pub fn list_promo_codes_for_catalog(input: ListPromoCodesInput) -> ExternResult<PromoCodesPage> {
    let mut query = LinkQuery::try_new(input.catalog_ref.clone(), LinkTypes::CatalogToPromoCode)?;
    query.before = input.before;
    let (links, next_before) = relay_coordinator_support::links::newest_first_page(query, PROMO_PAGE_SIZE)?;
    Ok(PromoCodesPage { promo_codes: promo_views(&input.catalog_ref, links), next_before })
}

#[cfg(feature = "test-utils")]
mod test_utils {
    use hdk::prelude::*;
    use catalog_integrity::{EntryTypes, LinkTypes, MerchantCatalog};
    relay_coordinator_support::raw_link_test_externs!(OwnerToCatalog, CatalogToMenuItem, GeohashToCatalog, CatalogToPromoCode, CatalogToBag, BagToClaim, CustomerToClaim, CatalogToLivePromo, CatalogToSuccessor, CatalogToPredecessor, CatalogToImport);

    /// Writes a store's move exactly as given -- what a modified client could.
    #[hdk_extern]
    pub fn create_raw_store_move_for_testing(moved: catalog_integrity::StoreSuccession) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::StoreSuccession(moved))
    }

    /// Writes a goodie-bag claim exactly as given, past the coordinator's
    /// checks -- so a test can prove what validation refuses.
    #[hdk_extern]
    pub fn create_raw_bag_claim_for_testing(claim: catalog_integrity::BagClaim) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::BagClaim(claim))
    }

    /// The anchor a store's listing sits under -- so a test can try forged
    /// listings where real ones go.
    #[hdk_extern]
    pub fn listing_anchor_for_testing(catalog_ref: ActionHash) -> ExternResult<AnyLinkableHash> {
        let (_, catalog): (_, MerchantCatalog) = relay_coordinator_support::resolve_latest_decoded(catalog_ref, "MerchantCatalog")?;
        Ok(super::geohash_anchor_path(&catalog.geohash)?.path_entry_hash()?.into())
    }

    #[derive(Serialize, Deserialize, Debug)]
    pub struct RawCatalogUpdate {
        pub original_action: ActionHash,
        pub catalog: MerchantCatalog,
    }

    /// Updates a catalog with exactly the entry given -- what a modified
    /// client could -- so a test can prove who validation lets update one.
    #[hdk_extern]
    pub fn update_raw_catalog_for_testing(input: RawCatalogUpdate) -> ExternResult<ActionHash> {
        update_entry(input.original_action, &EntryTypes::MerchantCatalog(input.catalog))
    }
}

// --- listing a store for customers to find ---

/// Lists a store (its original action) under its area, backed by a stake
/// from the owner's balance (`ledger::stake_listing`) -- in this same call,
/// so the two commit together.
fn list(catalog_ref: &ActionHash, geohash: &str) -> ExternResult<ActionHash> {
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "ledger", "stake_listing".into(), None, catalog_ref.clone())? else {
        return Err(guest("Listing a store sets aside a deposit from your balance, returned when you close it. Add funds to list it."));
    };
    let stake: ActionHash = io.decode().map_err(|e| wasm_error!(e))?;
    create_link(geohash_anchor_path(geohash)?.path_entry_hash()?, catalog_ref.clone(), LinkTypes::GeohashToCatalog, LinkTag::new(listing_tag(&stake)))
}

/// The caller's listing of their store, if it's listed: the link, and the
/// stake that backs it.
fn my_listing(catalog_ref: &ActionHash) -> ExternResult<Option<(Link, ActionHash)>> {
    let (_, catalog): (_, MerchantCatalog) = resolve_latest_decoded(catalog_ref.clone(), "MerchantCatalog")?;
    let me = agent_info()?.agent_initial_pubkey;
    let anchor = geohash_anchor_path(&catalog.geohash)?.path_entry_hash()?;
    let target = AnyLinkableHash::from(catalog_ref.clone());
    Ok(get_links(LinkQuery::try_new(anchor, LinkTypes::GeohashToCatalog)?.author(me), GetStrategy::Local)?
        .into_iter()
        .filter(|link| link.target == target)
        .find_map(|link| listing_stake(&link.tag.0).map(|stake| (link, stake))))
}

/// Whether the caller's store is listed for customers to find.
#[hdk_extern]
pub fn is_store_listed(catalog_ref: ActionHash) -> ExternResult<bool> {
    Ok(my_listing(&catalog_ref)?.is_some())
}

/// Takes the caller's store out of customers' listings and returns its
/// stake, in one commit. The store keeps answering the orders it has.
#[hdk_extern]
pub fn close_listing(catalog_ref: ActionHash) -> ExternResult<()> {
    let Some((link, stake)) = my_listing(&catalog_ref)? else { return Err(guest("This store isn't listed.")) };
    let delisting = delete_link(link.create_link_hash, GetOptions::default())?;
    #[derive(Serialize, Debug)]
    struct UnstakeWire {
        stake: ActionHash,
        delisting: ActionHash,
    }
    match call(CallTargetCell::Local, "ledger", "unstake_listing".into(), None, UnstakeWire { stake, delisting })? {
        ZomeCallResponse::Ok(_) => Ok(()),
        other => Err(guest(format!("couldn't return the listing deposit: {other:?}"))),
    }
}

/// Lists the caller's store again, with a fresh stake.
#[hdk_extern]
pub fn reopen_listing(catalog_ref: ActionHash) -> ExternResult<()> {
    if my_listing(&catalog_ref)?.is_some() {
        return Ok(());
    }
    let (_, catalog): (_, MerchantCatalog) = resolve_latest_decoded(catalog_ref.clone(), "MerchantCatalog")?;
    list(&catalog_ref, &catalog.geohash).map(|_| ())
}
