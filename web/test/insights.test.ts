import assert from "node:assert/strict";
import { test } from "node:test";
import { storeInsights, type InsightOrder } from "../src/lib/money/insights";

const order = (hour: number, status: string, total: number, lines: [string, number][], extra: Partial<InsightOrder> = {}): InsightOrder => ({
  placedAt: new Date(2026, 9, 12, hour, 15),
  status,
  delivery: true,
  totalCents: total,
  taxCents: 0,
  refundedCents: 0,
  lines: lines.map(([item, quantity]) => ({ item, quantity })),
  ...extra,
});

test("sales net of tax and refunds, best sellers, busy hours, lost orders", () => {
  const insights = storeInsights([
    order(12, "Delivered", 2000, [["stew", 1], ["bread", 2]]),
    order(12, "PickedUp", 1100, [["bread", 1]], { taxCents: 100, refundedCents: 550, delivery: false }),
    order(18, "Delivered", 1000, [["stew", 1]]),
    order(19, "Cancelled", 900, [["stew", 1]]),
    order(19, "Placed", 900, [["stew", 1]]),
  ]);
  assert.equal(insights.completed, 3);
  assert.equal(insights.cancelled, 1);
  // 2000 + (1100 - 100 tax - (550 refunded - 50 of it tax)) + 1000
  assert.equal(insights.netSalesCents, 2000 + 500 + 1000);
  assert.equal(insights.averageOrderCents, Math.round(3500 / 3));
  assert.deepEqual(insights.topItems, [{ item: "bread", quantity: 3 }, { item: "stew", quantity: 2 }], "only what was completed");
  assert.equal(insights.byHour[12], 2);
  assert.equal(insights.byHour[18], 1);
  assert.equal(insights.deliveryShare, 2 / 3);
});
