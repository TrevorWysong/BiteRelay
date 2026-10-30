import { bytesToHex, decodeEntry } from "../../holochain/decode";
import { getBagClaim, getGoodieBag, getModifierGroups, listMenuItems, type MenuItemsPage } from "../../holochain/zomes/catalog";
import type { ActionHash, BagClaim, GoodieBag, ModifierGroup, OrderLine, Selection, SelectionInput } from "../../holochain/types";
import type { MenuItem } from "../../holochain/types";
import type { CartLine } from "../../store/cart";
import { choiceLabels, linePrice, type Groups } from "./choices";

// Shared by merchant Catalog.tsx (managing a menu) and customer
// MerchantDetail.tsx (browsing one) -- both need "this item plus the hash
// it's stored under" and both group the same way for display.
export interface ItemRow {
  hash: Uint8Array;
  /// The item's latest version -- what an order line priced today names.
  version: Uint8Array;
  item: MenuItem;
}

/// A menu page as rows keyed by each item's stable identity (its original
/// action) -- never the latest record's hash, which changes on every edit.
function toItemRows(page: MenuItemsPage): ItemRow[] {
  return page.items.map((view) => ({ hash: view.original_action, version: view.record.signed_action.hashed.hash, item: decodeEntry<MenuItem>(view.record) }));
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
export async function fetchOrderItemNames(order: { catalog_ref: ActionHash; lines: OrderLine[]; bag_claim_ref: ActionHash | null }): Promise<Record<string, string>> {
  const names = itemNamesByHex(await fetchMenu(order.catalog_ref).catch(() => []));
  if (order.bag_claim_ref && order.lines[0]) {
    const bag = await getBagClaim(order.bag_claim_ref)
      .then((claim) => getGoodieBag(decodeEntry<BagClaim>(claim).bag_ref))
      .then((record) => decodeEntry<GoodieBag>(record))
      .catch(() => null);
    if (bag) names[bytesToHex(order.lines[0].item_ref)] = `🎁 ${bag.title}`;
  }
  return names;
}

/// Choices as an order holds them, without the versions they were priced
/// at -- what a new order of the same thing sends.
function selectionInputs(selections: Selection[]): SelectionInput[] {
  return selections.map((s) => ({ group: s.group, options: s.options.map((c) => ({ option: c.option, quantity: c.quantity, nested: selectionInputs(c.nested) })) }));
}

function groupRefs(selections: Selection[]): ActionHash[] {
  return selections.flatMap((s) => [s.group, ...s.options.flatMap((c) => groupRefs(c.nested))]);
}

/// A past order's lines as cart lines at the store's current menu: an item
/// since removed or sold out, or whose choices are no longer on offer, is
/// left out; one repriced takes its new price.
export async function cartLinesFromOrder(catalogRef: ActionHash, lines: OrderLine[], menu: ItemRow[]): Promise<CartLine[]> {
  const refs = new Map(lines.flatMap((line) => groupRefs(line.selections)).map((ref) => [bytesToHex(ref), ref]));
  const groups: Groups = new Map();
  if (refs.size > 0) {
    for (const view of await getModifierGroups(catalogRef, [...refs.values()])) groups.set(bytesToHex(view.original_action), decodeEntry<ModifierGroup>(view.record));
  }
  return lines.flatMap((line) => {
    const row = menu.find((m) => bytesToHex(m.hash) === bytesToHex(line.item_ref));
    if (!row || !row.item.available) return [];
    const selections = selectionInputs(line.selections);
    const priced = linePrice(row.item, selections, groups);
    if (!priced.ok) return [];
    return [{ itemRef: row.hash, name: row.item.name, basePriceCents: row.item.price_cents, priceCents: priced.price, quantity: line.quantity, selections, choiceLabels: choiceLabels(selections, groups) }];
  });
}
