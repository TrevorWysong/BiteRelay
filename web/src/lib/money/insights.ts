// How a store is doing over a period -- sales, orders, its best sellers,
// its busy hours, how many orders it lost -- from its own order history on
// its own device. Nothing about a store's trade is compiled anywhere else.
import type { DeliveryOrder, PickupOrder } from "../../holochain/types";
import { bytesToHex, decodeEntry } from "../../holochain/decode";
import { getOrderDecisions, getOrderHistoryForStore } from "../../holochain/zomes/dispatch";
import { refundedTax } from "./taxReport";

export interface InsightOrder {
  placedAt: Date;
  status: string;
  delivery: boolean;
  totalCents: number;
  taxCents: number;
  refundedCents: number;
  /// Each line's item (its original action, hex) and quantity.
  lines: { item: string; quantity: number }[];
}

export interface StoreInsights {
  completed: number;
  cancelled: number;
  /// What the completed orders came to, before tax and after refunds.
  netSalesCents: number;
  averageOrderCents: number;
  /// Best sellers, by units sold.
  topItems: { item: string; quantity: number }[];
  /// Completed orders by the hour of day they were placed, local time.
  byHour: number[];
  deliveryShare: number;
}

const COMPLETED = new Set(["Delivered", "PickedUp"]);

export function storeInsights(orders: InsightOrder[]): StoreInsights {
  const completed = orders.filter((o) => COMPLETED.has(o.status));
  const net = (o: InsightOrder) => o.totalCents - o.taxCents - (o.refundedCents - refundedTax(o.refundedCents, o.totalCents, o.taxCents));
  const netSalesCents = completed.reduce((sum, o) => sum + net(o), 0);
  const units = new Map<string, number>();
  const byHour = new Array<number>(24).fill(0);
  for (const order of completed) {
    byHour[order.placedAt.getHours()]++;
    for (const line of order.lines) units.set(line.item, (units.get(line.item) ?? 0) + line.quantity);
  }
  return {
    completed: completed.length,
    cancelled: orders.filter((o) => o.status === "Cancelled").length,
    netSalesCents,
    averageOrderCents: completed.length ? Math.round(netSalesCents / completed.length) : 0,
    topItems: [...units].map(([item, quantity]) => ({ item, quantity })).sort((a, b) => b.quantity - a.quantity || a.item.localeCompare(b.item)).slice(0, 5),
    byHour,
    deliveryShare: completed.length ? completed.filter((o) => o.delivery).length / completed.length : 0,
  };
}

/// History pages read at most, so a long history can't stall the card.
const MAX_PAGES = 60;

/// The store's orders placed since `from`, newest first.
export async function storeOrdersSince(catalogRef: Uint8Array, from: Date): Promise<InsightOrder[]> {
  const fromMicros = from.getTime() * 1000;
  const orders: InsightOrder[] = [];
  let before: number | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await getOrderHistoryForStore(catalogRef, before, 50);
    let reachedStart = false;
    for (const entry of result.orders) {
      const order = decodeEntry<DeliveryOrder | PickupOrder>(entry.record);
      if (order.requested_at < fromMicros) {
        reachedStart = true;
        continue;
      }
      const done = COMPLETED.has(order.status as string);
      const refund = done ? ((await getOrderDecisions(entry.original_action).catch(() => null))?.refund ?? 0) : 0;
      orders.push({
        placedAt: new Date(order.requested_at / 1000),
        status: order.status as string,
        delivery: "dropoff_geohash" in order,
        totalCents: order.order_total,
        taxCents: order.tax_cents ?? 0,
        refundedCents: refund,
        lines: order.lines.map((l) => ({ item: bytesToHex(l.item_ref), quantity: l.quantity })),
      });
    }
    if (reachedStart || result.next_before === null) break;
    before = result.next_before;
  }
  return orders;
}
