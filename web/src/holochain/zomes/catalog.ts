import { callZome } from "../client";
import type { ActionHash, AgentPubKey, GeoPoint, TaxRate, HcRecord, MenuItem, MerchantCatalog, ModifierGroup, OpeningPeriod, PromoRequirement, PromoReward, GoodieBag, Timestamp } from "../types";

// An entry's stable identity (its original action) alongside its latest
// content -- see the Rust `CatalogView`. Always pass `original_action` on
// (as `catalog_ref`, an item or promo ref, ...), never `actionHash(record)`,
// which changes on every edit. Menu items, promo codes and goodie bags come
// back the same way.
export interface CatalogView {
  original_action: ActionHash;
  record: HcRecord;
}

export type PromoView = CatalogView;
export type MenuItemView = CatalogView;
export type BagView = CatalogView;

export interface NearbyMerchantsPage {
  catalogs: CatalogView[];
  next_after: Timestamp | null;
}

export interface MenuItemsPage {
  items: MenuItemView[];
  next_after: Timestamp | null;
}

export interface CatalogDetails {
  description?: string;
  cuisine_type?: string;
  banner_data_uri?: string;
  phone?: string;
  address_street?: string;
  address_city?: string;
  address_state?: string;
  address_zip?: string;
  /// When the store takes orders, in `time_zone` -- empty for no set hours.
  weekly_hours?: OpeningPeriod[];
  /// The store's IANA time zone; the device's own when it's set up or edited.
  time_zone?: string;
  /// The kitchen's usual prep time, in minutes.
  prep_minutes?: number;
  max_delivery_radius_km?: number;
}

/// The device's IANA time zone -- what a store's hours mean.
export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const EMPTY_DETAILS: Required<CatalogDetails> = {
  description: "",
  cuisine_type: "",
  banner_data_uri: "",
  phone: "",
  address_street: "",
  address_city: "",
  address_state: "",
  address_zip: "",
  weekly_hours: [],
  time_zone: "UTC",
  prep_minutes: 15,
  max_delivery_radius_km: 8,
};

/// Every editable detail of a store as it stands -- what an edit to some
/// of them starts from, since an update replaces them all.
export function detailsOf(catalog: MerchantCatalog): Required<CatalogDetails> {
  return {
    description: catalog.description,
    cuisine_type: catalog.cuisine_type,
    banner_data_uri: catalog.banner_data_uri,
    phone: catalog.phone,
    address_street: catalog.address_street,
    address_city: catalog.address_city,
    address_state: catalog.address_state,
    address_zip: catalog.address_zip,
    weekly_hours: catalog.weekly_hours,
    time_zone: catalog.time_zone,
    prep_minutes: catalog.prep_minutes,
    max_delivery_radius_km: catalog.max_delivery_radius_km,
  };
}

export async function publishCatalog(input: { business_name: string; location: GeoPoint } & CatalogDetails): Promise<HcRecord> {
  return callZome("catalog", "publish_catalog", { ...EMPTY_DETAILS, time_zone: deviceTimeZone(), ...input });
}

// Every store the caller owns, oldest first, resolved directly via the
// OwnerToCatalog links -- not by geohash discovery, so independent of
// whatever `location` happens to be set to right now.
//
// Each entry carries `original_action` separately from `record` -- always
// use `original_action` as `catalog_ref` (passed to `addMenuItem`,
// `createPromoCode`, `listMenuItems`, `getOrdersForStore`, ...), never
// `actionHash(record)`. The record's own action hash reflects whatever
// this catalog's *latest* state is, which changes on every edit; using it
// as `catalog_ref` would silently orphan everything already linked under
// the previous hash. Same `CatalogView` shape `getNearbyMerchants` returns
// per-catalog, for the same reason.
export async function listMyCatalogs(): Promise<CatalogView[]> {
  return callZome("catalog", "list_my_catalogs", null);
}

/// Replaces every detail -- start from `detailsOf(catalog)` and change what's
/// being edited.
export async function updateCatalogDetails(originalAction: ActionHash, details: Required<CatalogDetails>): Promise<HcRecord> {
  return callZome("catalog", "update_catalog_details", { original_action: originalAction, ...details });
}

export async function setCatalogOpen(originalAction: ActionHash, isOpen: boolean): Promise<HcRecord> {
  return callZome("catalog", "set_catalog_open", { original_action: originalAction, is_open: isOpen });
}

/// A single catalog by reference -- Cart.tsx uses this to read the
/// merchant's current `delivery_subsidy_percent` before checkout
/// (architecture plan §12: the standard delivery-cost-sharing model).
/// Whether the caller's store is listed for customers to find.
export async function isStoreListed(catalogRef: ActionHash): Promise<boolean> {
  return callZome("catalog", "is_store_listed", catalogRef);
}

/// Takes the caller's store out of customers' listings, returning its
/// listing deposit. It keeps answering the orders it has.
export async function closeListing(catalogRef: ActionHash): Promise<void> {
  return callZome("catalog", "close_listing", catalogRef);
}

/// Lists the caller's store again, setting aside a fresh deposit.
export async function reopenListing(catalogRef: ActionHash): Promise<void> {
  return callZome("catalog", "reopen_listing", catalogRef);
}

export async function getCatalog(catalogRef: ActionHash): Promise<HcRecord> {
  return callZome("catalog", "get_catalog", catalogRef);
}

/// Whether the store's conductor accepts new orders on its own -- see
/// `MerchantCatalog.auto_accept_orders`.
export async function setAutoAcceptOrders(originalAction: ActionHash, autoAcceptOrders: boolean): Promise<HcRecord> {
  return callZome("catalog", "set_auto_accept_orders", { original_action: originalAction, auto_accept_orders: autoAcceptOrders });
}

export async function setDeliverySubsidyPercent(originalAction: ActionHash, deliverySubsidyPercent: number): Promise<HcRecord> {
  return callZome("catalog", "set_delivery_subsidy_percent", { original_action: originalAction, delivery_subsidy_percent: deliverySubsidyPercent });
}

const EMPTY_ITEM_DETAILS = { description: "", photo_data_uri: "", category: "", dietary_tags: [] as string[], modifier_groups: [] as ActionHash[] };

export async function addMenuItem(
  input: { catalog_ref: ActionHash; name: string; price_cents: number; available: boolean } & Partial<Pick<MenuItem, "description" | "photo_data_uri" | "category" | "dietary_tags" | "modifier_groups">>,
): Promise<HcRecord> {
  return callZome("catalog", "add_menu_item", { ...EMPTY_ITEM_DETAILS, ...input });
}

export async function updateMenuItem(originalAction: ActionHash, item: MenuItem): Promise<HcRecord> {
  return callZome("catalog", "update_menu_item", { original_action: originalAction, item });
}

export async function createModifierGroup(group: ModifierGroup): Promise<HcRecord> {
  return callZome("catalog", "create_modifier_group", group);
}

export async function updateModifierGroup(originalAction: ActionHash, group: ModifierGroup): Promise<HcRecord> {
  return callZome("catalog", "update_modifier_group", { original_action: originalAction, group });
}

/// Every choice group a store has -- what its owner manages.
export async function listModifierGroups(catalogRef: ActionHash): Promise<CatalogView[]> {
  return callZome("catalog", "list_modifier_groups", catalogRef);
}

/// Some of a store's choice groups at their latest -- an item's, and those
/// its options open.
export async function getModifierGroups(catalogRef: ActionHash, groups: ActionHash[]): Promise<CatalogView[]> {
  return callZome("catalog", "get_modifier_groups", { catalog_ref: catalogRef, groups });
}

export async function listMenuItems(catalogRef: ActionHash, after: Timestamp | null = null): Promise<MenuItemsPage> {
  return callZome("catalog", "list_menu_items", { catalog_ref: catalogRef, after });
}

export async function getNearbyMerchants(geohash: string, after: Timestamp | null = null): Promise<NearbyMerchantsPage> {
  return callZome("catalog", "get_nearby_merchants", { geohash, after });
}

// --- promo codes ---

export async function createPromoCode(input: {
  catalog_ref: ActionHash;
  code: string;
  requirement: PromoRequirement;
  reward: PromoReward;
  expires_at?: Timestamp | null;
  auto_apply?: boolean;
}): Promise<HcRecord> {
  return callZome("catalog", "create_promo_code", { expires_at: null, auto_apply: false, ...input });
}

/// A promo code at its latest state (is it still active?).
export async function getPromoCode(promoRef: ActionHash): Promise<HcRecord> {
  return callZome("catalog", "get_promo_code", promoRef);
}

export async function setPromoCodeActive(originalAction: ActionHash, active: boolean): Promise<HcRecord> {
  return callZome("catalog", "set_promo_code_active", { original_action: originalAction, active });
}

/// The codes a customer can use at this store right now (active, not
/// expired) -- checkout's list.
export async function listLivePromoCodes(catalogRef: ActionHash): Promise<PromoView[]> {
  return callZome("catalog", "list_live_promo_codes", catalogRef);
}

export interface PromoCodesPage {
  promo_codes: PromoView[];
  next_before: Timestamp | null;
}

/// Every code the store has created, newest first -- the merchant's list.
export async function listPromoCodesForCatalog(catalogRef: ActionHash, before: Timestamp | null = null): Promise<PromoCodesPage> {
  return callZome("catalog", "list_promo_codes_for_catalog", { catalog_ref: catalogRef, before });
}

// --- goodie bags (limited-quantity, time-windowed, discounted mystery bags of surplus food) ---

export interface CreateGoodieBagInput {
  catalog_ref: ActionHash;
  title: string;
  description?: string;
  photo_data_uri?: string;
  original_value_cents: number;
  price_cents: number;
  quantity_total: number;
  pickup_window_start: Timestamp;
  pickup_window_end: Timestamp;
  supports_pickup: boolean;
  supports_delivery: boolean;
  /// How long a confirmed claim is held for its customer to order it --
  /// the network's default if left out.
  hold_minutes?: number;
}

export async function createGoodieBag(input: CreateGoodieBagInput): Promise<HcRecord> {
  return callZome("catalog", "create_goodie_bag", {
    description: "",
    photo_data_uri: "",
    ...input,
    created_at: Date.now() * 1000,
  });
}

// `bag` must be the *full* current entry (e.g. decoded from `getGoodieBag`)
// with whatever fields changed -- same full-replace convention as
// `updateMenuItem`, and `created_at` must be the bag's original value, not
// a fresh timestamp.
export async function updateGoodieBag(originalAction: ActionHash, bag: GoodieBag): Promise<HcRecord> {
  return callZome("catalog", "update_goodie_bag", { original_action: originalAction, bag });
}

export async function getGoodieBag(bagRef: ActionHash): Promise<HcRecord> {
  return callZome("catalog", "get_goodie_bag", bagRef);
}

/// The store's bags that can still be claimed. Bags live at most a week
/// (validation caps it), so this never reads a store's whole bag history.
export async function listGoodieBagsForCatalog(catalogRef: ActionHash): Promise<BagView[]> {
  return callZome("catalog", "list_goodie_bags_for_catalog", catalogRef);
}

export async function getNearbyGoodieBags(geohash: string, after: Timestamp | null = null): Promise<BagView[]> {
  return callZome("catalog", "get_nearby_goodie_bags", { geohash, after });
}

/// How a customer wants a claimed bag, in the clear -- the zome seals a
/// delivery drop-off before storing the claim.
export type FulfillmentInput = "Pickup" | { Delivery: { dropoff: GeoPoint; max_delivery_fee: number | null } };

export async function claimGoodieBag(bagRef: ActionHash, fulfillment: FulfillmentInput): Promise<HcRecord> {
  return callZome("catalog", "claim_goodie_bag", { bag_ref: bagRef, fulfillment });
}

export async function getBagClaim(claimRef: ActionHash): Promise<HcRecord> {
  return callZome("catalog", "get_bag_claim", claimRef);
}

export async function listClaimsForBag(bagRef: ActionHash): Promise<HcRecord[]> {
  return callZome("catalog", "list_claims_for_bag", bagRef);
}

/// One of the caller's claims, with a delivery claim's drop-off opened.
export interface MyClaim {
  record: HcRecord;
  dropoff: GeoPoint | null;
}

export async function getMyBagClaims(): Promise<MyClaim[]> {
  return callZome("catalog", "get_my_bag_claims", null);
}

export async function listPendingClaimsForMerchant(catalogRef: ActionHash): Promise<HcRecord[]> {
  return callZome("catalog", "list_pending_claims_for_merchant", catalogRef);
}

export async function confirmClaim(claimRef: ActionHash): Promise<HcRecord> {
  return callZome("catalog", "confirm_claim", claimRef);
}

/// The most an order may cost to be left at the door, in cents -- `null`
/// for no limit.
/// The smallest order the store takes, in minor units -- `null` for any size.
/// The store's sales tax or VAT -- orders placed from here on are taxed at
/// these rates.
export async function setTaxSettings(originalAction: ActionHash, settings: { tax_rates: TaxRate[]; prices_include_tax: boolean; tax_registration: string }): Promise<HcRecord> {
  return callZome("catalog", "set_tax_settings", { original_action: originalAction, ...settings });
}

export async function setMinimumOrder(originalAction: ActionHash, minCents: number | null): Promise<HcRecord> {
  return callZome("catalog", "set_minimum_order", { original_action: originalAction, min_cents: minCents });
}

/// How long the store may keep a checked-in driver waiting past an order's
/// ready time -- `null` for the network's. Orders keep the wait they were
/// placed under.
export async function setStoreWait(originalAction: ActionHash, minutes: number | null): Promise<HcRecord> {
  return callZome("catalog", "set_store_wait", { original_action: originalAction, minutes });
}

/// Minutes the store adds to its usual prep time while busy; 0 when it isn't.
export async function setBusy(originalAction: ActionHash, extraMinutes: number): Promise<HcRecord> {
  return callZome("catalog", "set_busy", { original_action: originalAction, extra_minutes: extraMinutes });
}

export async function setLeaveAtDoorLimit(originalAction: ActionHash, maxCents: number | null): Promise<HcRecord> {
  return callZome("catalog", "set_leave_at_door_limit", { original_action: originalAction, max_cents: maxCents });
}

// --- a store moved to its owner's new key (catalog zome's `moves`) ---

/// The stores `owner` has published.
export async function catalogsOf(owner: AgentPubKey): Promise<CatalogView[]> {
  return callZome("catalog", "catalogs_of", owner);
}

/// Republishes `from`, a store of the account the caller took over, as the
/// caller's own; returns the new store.
export async function moveStore(from: ActionHash): Promise<ActionHash> {
  return callZome("catalog", "move_store", from);
}

/// Where a store moved to, if its owner moved it to a new key.
export async function storeSuccessor(catalogRef: ActionHash): Promise<ActionHash | null> {
  return callZome("catalog", "store_successor", catalogRef);
}
