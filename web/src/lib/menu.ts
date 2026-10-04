import type { MenuItem } from "../holochain/types";

// Shared by merchant Catalog.tsx (managing a menu) and customer
// MerchantDetail.tsx (browsing one) -- both need "this item plus the hash
// it's stored under" and both group the same way for display.
export interface ItemRow {
  hash: Uint8Array;
  item: MenuItem;
}

export function groupByCategory(rows: ItemRow[]): Map<string, ItemRow[]> {
  const grouped = new Map<string, ItemRow[]>();
  for (const row of rows) {
    const key = row.item.category || "Menu";
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}
