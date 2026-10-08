// The cart's promo arithmetic must agree with the Rust pricing that
// validation enforces (catalog_types::pricing) -- the same cases run there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePromo } from "../src/lib/promotions.ts";
import type { CartLine } from "../src/store/cart.ts";
import type { PromoCode, PromoRequirement, PromoReward } from "../src/holochain/types.ts";

const item = (n: number) => new Uint8Array(39).fill(n);
const line = (n: number, priceCents: number, quantity: number): CartLine => ({ itemRef: item(n), name: `item ${n}`, priceCents, quantity });
const subtotal = (lines: CartLine[]) => lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0);

/// The order total, or null if the promo's requirement isn't met.
function orderTotal(lines: CartLine[], requirement: PromoRequirement, reward: PromoReward, completedOrders = 0): number | null {
  const promo = { requirement, reward } as PromoCode;
  const { eligible, effect } = evaluatePromo(promo, lines, subtotal(lines), completedOrders);
  return eligible ? subtotal(lines) - Math.min(effect.subtotalDiscountCents, subtotal(lines)) : null;
}

test("percent off the subtotal rounds down", () => {
  assert.equal(orderTotal([line(1, 333, 1)], "None", { PercentOffSubtotal: 10 }), 300);
});

test("a flat discount never exceeds the subtotal", () => {
  assert.equal(orderTotal([line(1, 500, 1)], "None", { FlatOffSubtotal: 800 }), 0);
});

test("a free item is capped at what the cart holds", () => {
  assert.equal(orderTotal([line(1, 450, 1), line(2, 1000, 1)], "None", { FreeItem: { item_ref: item(1), quantity: 2 } }), 1000);
});

test("buy two get one free", () => {
  const requirement = { MinimumItemQuantity: { item_ref: item(1), quantity: 2 } };
  const reward = { FreeItem: { item_ref: item(1), quantity: 1 } };
  assert.equal(orderTotal([line(1, 400, 3)], requirement, reward), 800);
  assert.equal(orderTotal([line(1, 400, 1)], requirement, reward), null);
});

test("percent off an item rounds down per unit", () => {
  assert.equal(orderTotal([line(1, 999, 2)], "None", { PercentOffItem: { item_ref: item(1), percent: 50, quantity: 1 } }), 999 * 2 - 499);
});

test("minimum spend counts the whole cart", () => {
  assert.equal(orderTotal([line(1, 1000, 2)], { MinimumSpend: 2000 }, { FlatOffSubtotal: 500 }), 1500);
  assert.equal(orderTotal([line(1, 1000, 1)], { MinimumSpend: 2000 }, { FlatOffSubtotal: 500 }), null);
});

test("loyalty needs enough completed orders", () => {
  assert.equal(orderTotal([line(1, 1000, 1)], { LoyaltyOrderCount: 5 }, { PercentOffSubtotal: 15 }, 5), 850);
  assert.equal(orderTotal([line(1, 1000, 1)], { LoyaltyOrderCount: 5 }, { PercentOffSubtotal: 15 }, 4), null);
});
