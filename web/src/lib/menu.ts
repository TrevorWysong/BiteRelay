import { bytesToHex, decodeEntry } from "../holochain/decode";
import { getBagClaim, getGoodieBag, listMenuItems, type MenuItemsPage } from "../holochain/zomes/catalog";
import type { ActionHash, BagClaim, GoodieBag } from "../holochain/types";
import type { MenuItem } from "../holochain/types";

// Shared by merchant Catalog.tsx (managing a menu) and customer
// MerchantDetail.tsx (browsing one) -- both need "this item plus the hash
// it's stored under" and both group the same way for display.
export interface ItemRow {
  hash: Uint8Array;
  item: MenuItem;
}

/// A menu page as rows keyed by each item's stable identity (its original
/// action) -- never the latest record's hash, which changes on every edit.
function toItemRows(page: MenuItemsPage): ItemRow[] {
  return page.items.map((view) => ({ hash: view.original_action, item: decodeEntry<MenuItem>(view.record) }));
}

/// A store's whole menu, every page of it. A menu is bounded by what its
/// store lists, and every screen that reads one needs all of it -- a
/// customer browsing, a cart pricing a promo's free item, a merchant
/// managing it -- so stopping at the first page would silently hide items.
export async function fetchMenu(catalogRef: ActionHash): Promise<ItemRow[]> {
  const rows: ItemRow[] = [];
  let after = null;
  do {
    const page: MenuItemsPage = await listMenuItems(catalogRef, after);
    rows.push(...toItemRows(page));
    after = page.next_after;
  } while (after !== null);
  return rows;
}

/// Item names by identity hex, for labelling an order's or promo's item refs.
export function itemNamesByHex(rows: ItemRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [bytesToHex(row.hash), row.item.name]));
}

export function groupByCategory(rows: ItemRow[]): Map<string, ItemRow[]> {
  const grouped = new Map<string, ItemRow[]>();
  for (const row of rows) {
    const key = row.item.category || "Menu";
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}

/// Display names for an order's items (either kind of order): the store's
/// menu, plus -- for a goodie-bag order, whose one item ref is the bag
/// rather than a menu item -- the bag's title.
export async function fetchOrderItemNames(order: { catalog_ref: ActionHash; item_refs: ActionHash[]; bag_claim_ref: ActionHash | null }): Promise<Record<string, string>> {
  const names = itemNamesByHex(await fetchMenu(order.catalog_ref).catch(() => []));
  if (order.bag_claim_ref && order.item_refs[0]) {
    const bag = await getBagClaim(order.bag_claim_ref)
      .then((claim) => getGoodieBag(decodeEntry<BagClaim>(claim).bag_ref))
      .then((record) => decodeEntry<GoodieBag>(record))
      .catch(() => null);
    if (bag) names[bytesToHex(order.item_refs[0])] = `🎁 ${bag.title}`;
  }
  return names;
}
