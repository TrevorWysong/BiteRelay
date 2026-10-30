// A merchant's in-progress orders across their stores -- read by the order
// queue screen and by the app shell's "orders waiting" alert.
import { getActiveOrdersForStore, type OrderEntry } from "../holochain/zomes/dispatch";
import { toOrderRow, type OrderRow } from "../lib/orders/orderEntries";
import { responseDeadlineMs } from "../lib/orders/storeAnswers";
import type { StoreRow } from "./merchantStores";

/// An order, labelled with the store it came in at.
export type QueueRow = OrderRow & { storeHex: string };

export function toRow(entry: OrderEntry, storeHex: string): QueueRow {
  return { ...toOrderRow(entry), storeHex };
}

export const storesKey = (stores: StoreRow[]) => stores.map((s) => s.hex).join(",");

/// Every in-progress order across `stores`, oldest first: the order a
/// kitchen works through them.
export async function fetchActiveQueue(stores: StoreRow[]): Promise<QueueRow[]> {
  const perStore = await Promise.all(stores.map(async (store) => (await getActiveOrdersForStore(store.hash)).map((entry) => toRow(entry, store.hex))));
  return perStore.flat().sort((a, b) => a.order.requested_at - b.order.requested_at);
}

/// Whether an order is waiting on its store to accept it, with time left.
export function awaitsAnswer(row: QueueRow, windowSecs: number, now: number): boolean {
  return row.order.status === "Placed" && now < responseDeadlineMs(row.writtenAt, windowSecs);
}
