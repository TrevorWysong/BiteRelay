import { callZome } from "../client";
import type { ActionHash, GeoPoint, HcRecord, MenuItem, PromoRequirement, PromoReward, Timestamp } from "../types";

export interface NearbyMerchantsPage {
  catalogs: HcRecord[];
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
  address_line?: string;
  hours_open?: string;
  hours_close?: string;
}

const EMPTY_DETAILS: Required<CatalogDetails> = {
  description: "",
  cuisine_type: "",
  banner_data_uri: "",
  phone: "",
  address_line: "",
  hours_open: "",
  hours_close: "",
};

export async function publishCatalog(input: { business_name: string; location: GeoPoint } & CatalogDetails): Promise<HcRecord> {
  return callZome("catalog", "publish_catalog", { ...EMPTY_DETAILS, ...input });
}

// Resolves the caller's own catalog directly via the OwnerToCatalog link,
// not by geohash discovery -- independent of whatever `location` happens
// to be set to right now, and stable even if a stale conductor build once
// let a duplicate get created (see the Rust extern's own doc comment).
export async function getMyCatalog(): Promise<HcRecord | null> {
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
