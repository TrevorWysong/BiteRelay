// A store's tax report: what it sold in a period and the tax it collected,
// net of the tax it refunded on reports of missing items -- computed on the
// store's own device from its own order history, so its sales are never
// compiled anywhere else (TAX_REPORTING.md). What it files is its own.
import type { DeliveryOrder, PickupOrder } from "../holochain/types";
import { decodeEntry } from "../holochain/decode";
import { getOrderDecisions, getOrderHistoryForStore, type OrderEntry } from "../holochain/zomes/dispatch";

/// One completed order, as the report lists it.
export interface TaxedOrder {
  placedAt: Date;
  /// What the customer paid the store (with tax when it's added on top).
  totalCents: number;
  taxCents: number;
  /// What the store refunded on reports, and the tax in it.
  refundedCents: number;
  refundedTaxCents: number;
}

export interface TaxReport {
  orders: TaxedOrder[];
  salesCents: number;
  taxCents: number;
  refundedTaxCents: number;
  /// The tax collected, less what was refunded.
  netTaxCents: number;
}

const COMPLETED = new Set(["Delivered", "PickedUp"]);
/// History pages read at most, so a long history can't stall the report.
const MAX_PAGES = 200;

/// A refund's share of the tax: the same share of the order it is.
export function refundedTax(refundCents: number, totalCents: number, taxCents: number): number {
  return totalCents === 0 ? 0 : Math.round((refundCents * taxCents) / totalCents);
}

export function summarize(orders: TaxedOrder[]): TaxReport {
  const sum = (pick: (o: TaxedOrder) => number) => orders.reduce((total, o) => total + pick(o), 0);
  const taxCents = sum((o) => o.taxCents);
  const refundedTaxCents = sum((o) => o.refundedTaxCents);
  return { orders, salesCents: sum((o) => o.totalCents - o.refundedCents), taxCents, refundedTaxCents, netTaxCents: taxCents - refundedTaxCents };
}

/// The store's completed orders placed in [from, to), and their tax.
export async function storeTaxReport(catalogRef: Uint8Array, from: Date, to: Date): Promise<TaxReport> {
  const fromMicros = from.getTime() * 1000;
  const entries: OrderEntry[] = [];
  let before: number | null = to.getTime() * 1000 - 1;
  for (let page = 0; page < MAX_PAGES && before !== null; page++) {
    const result = await getOrderHistoryForStore(catalogRef, before, 50);
    entries.push(...result.orders);
    const oldest = result.orders.at(-1);
    if (oldest && decodeEntry<{ requested_at: number }>(oldest.record).requested_at < fromMicros) break;
    before = result.next_before;
  }
  const orders: TaxedOrder[] = [];
  for (const entry of entries) {
    const order = decodeEntry<DeliveryOrder | PickupOrder>(entry.record);
    if (order.requested_at < fromMicros || order.requested_at >= to.getTime() * 1000) continue;
    if (!COMPLETED.has(order.status as string)) continue;
    const refund = (await getOrderDecisions(entry.original_action).catch(() => null))?.refund ?? 0;
    const taxCents = order.tax_cents ?? 0;
    orders.push({ placedAt: new Date(order.requested_at / 1000), totalCents: order.order_total, taxCents, refundedCents: refund, refundedTaxCents: refundedTax(refund, order.order_total, taxCents) });
  }
  return summarize(orders.sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime()));
}

/// The report's orders as CSV, for the store's accountant.
export function taxReportCsv(report: TaxReport, minor: (cents: number) => string): string {
  const rows = report.orders.map((o) => [o.placedAt.toISOString(), minor(o.totalCents), minor(o.taxCents), minor(o.refundedCents), minor(o.refundedTaxCents)].join(","));
  return ["placed_at,total,tax,refunded,refunded_tax", ...rows].join("\n");
}
