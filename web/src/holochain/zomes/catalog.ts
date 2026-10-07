import { callZome } from "../client";
import type { ActionHash, BagClaimFulfillment, GeoPoint, HcRecord, MenuItem, PromoRequirement, PromoReward, GoodieBag, Timestamp } from "../types";

// Pairs a catalog's stable identity with its current content -- see the
// Rust `CatalogView`'s own doc comment for the bug this exists to avoid.
// Always use `original_action` as `catalog_ref` downstream
// (listMenuItems, listPromoCodesForCatalog, listGoodieBagsForCatalog,
// ...), never `actionHash(record)`.
export interface CatalogView {
  original_action: ActionHash;
  record: HcRecord;
}

export interface NearbyMerchantsPage {
  catalogs: CatalogView[];
  next_after: Timestamp | null;
}

export interface MenuItemsPage {
  items: HcRecord[];
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
  hours_open?: string;
  hours_close?: string;
  max_delivery_radius_km?: number;
}

const EMPTY_DETAILS: Required<CatalogDetails> = {
  description: "",
  cuisine_type: "",
  banner_data_uri: "",
  phone: "",
  address_street: "",
  address_city: "",
  address_state: "",
  address_zip: "",
  hours_open: "",
  hours_close: "",
  max_delivery_radius_km: 8,
};

export async function publishCatalog(input: { business_name: string; location: GeoPoint } & CatalogDetails): Promise<HcRecord> {
  return callZome("catalog", "publish_catalog", { ...EMPTY_DETAILS, ...input });
}

// Resolves the caller's own catalog directly via the OwnerToCatalog link,
// not by geohash discovery -- independent of whatever `location` happens
// to be set to right now, and stable even if a stale conductor build once
// let a duplicate get created (see the Rust extern's own doc comment).
//
// Returns `original_action` separately from `record` -- always use
// `original_action` as `catalog_ref` (passed to `addMenuItem`,
// `createPromoCode`, `listMenuItems`, `listPromoCodesForCatalog`, ...),
// never `actionHash(record)`. The record's own action hash reflects
// whatever this catalog's *latest* state is, which changes on every edit;
// using it as `catalog_ref` would silently orphan everything already
// linked under the previous hash. Same `CatalogView` shape
// `getNearbyMerchants` returns per-catalog, for the same reason -- see
// that extern's own doc comment for where this exact bug was found a
// second time.
export async function getMyCatalog(): Promise<CatalogView | null> {
  return callZome("catalog", "get_my_catalog", null);
}

export async function updateCatalogDetails(originalAction: ActionHash, details: CatalogDetails): Promise<HcRecord> {
  return callZome("catalog", "update_catalog_details", { original_action: originalAction, ...EMPTY_DETAILS, ...details });
}

export async function setCatalogOpen(originalAction: ActionHash, isOpen: boolean): Promise<HcRecord> {
  return callZome("catalog", "set_catalog_open", { original_action: originalAction, is_open: isOpen });
}

/// A single catalog by reference -- Cart.tsx uses this to read the
/// merchant's current `delivery_subsidy_percent` before checkout
/// (architecture plan §12: the standard delivery-cost-sharing model).
export async function getCatalog(catalogRef: ActionHash): Promise<HcRecord> {
  return callZome("catalog", "get_catalog", catalogRef);
}

export async function setDeliverySubsidyPercent(originalAction: ActionHash, deliverySubsidyPercent: number): Promise<HcRecord> {
  return callZome("catalog", "set_delivery_subsidy_percent", { original_action: originalAction, delivery_subsidy_percent: deliverySubsidyPercent });
}

const EMPTY_ITEM_DETAILS = { description: "", photo_data_uri: "", category: "", dietary_tags: [] as string[] };

export async function addMenuItem(
  input: { catalog_ref: ActionHash; name: string; price_cents: number; available: boolean } & Partial<Pick<MenuItem, "description" | "photo_data_uri" | "category" | "dietary_tags">>,
): Promise<HcRecord> {
  return callZome("catalog", "add_menu_item", { ...EMPTY_ITEM_DETAILS, ...input });
}

export async function updateMenuItem(originalAction: ActionHash, item: MenuItem): Promise<HcRecord> {
  return callZome("catalog", "update_menu_item", { original_action: originalAction, item });
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

export async function setPromoCodeActive(originalAction: ActionHash, active: boolean): Promise<HcRecord> {
  return callZome("catalog", "set_promo_code_active", { original_action: originalAction, active });
}

export async function listPromoCodesForCatalog(catalogRef: ActionHash): Promise<HcRecord[]> {
  return callZome("catalog", "list_promo_codes_for_catalog", catalogRef);
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

export async function listGoodieBagsForCatalog(catalogRef: ActionHash): Promise<HcRecord[]> {
  return callZome("catalog", "list_goodie_bags_for_catalog", catalogRef);
}

export async function getNearbyGoodieBags(geohash: string, after: Timestamp | null = null): Promise<HcRecord[]> {
  return callZome("catalog", "get_nearby_goodie_bags", { geohash, after });
}

export async function claimGoodieBag(bagRef: ActionHash, fulfillment: BagClaimFulfillment): Promise<HcRecord> {
  return callZome("catalog", "claim_goodie_bag", { bag_ref: bagRef, fulfillment });
}

export async function getBagClaim(claimRef: ActionHash): Promise<HcRecord> {
  return callZome("catalog", "get_bag_claim", claimRef);
}

export async function listClaimsForBag(bagRef: ActionHash): Promise<HcRecord[]> {
  return callZome("catalog", "list_claims_for_bag", bagRef);
}

export async function getMyBagClaims(): Promise<HcRecord[]> {
  return callZome("catalog", "get_my_bag_claims", null);
}

export async function listPendingClaimsForMerchant(catalogRef: ActionHash): Promise<HcRecord[]> {
  return callZome("catalog", "list_pending_claims_for_merchant", catalogRef);
}

export async function confirmClaim(claimRef: ActionHash): Promise<HcRecord> {
  return callZome("catalog", "confirm_claim", claimRef);
}
