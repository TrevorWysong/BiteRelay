import assert from "node:assert/strict";
import { test } from "node:test";
import { autoBidPrice, skipsStore } from "../src/lib/driving/autoBid.ts";

const terms = { rule: { on: true, perKmCents: 100, skipRefusals: 3 }, minFeeCents: 300 };

test("a driver bids their rate for the trip", () => {
  assert.equal(autoBidPrice(7.2, null, terms), 720);
});

test("never under their lowest fee", () => {
  assert.equal(autoBidPrice(1, null, terms), 300);
});

test("never over the customer's cap: no bid at all", () => {
  assert.equal(autoBidPrice(7.2, 700, terms), null);
  assert.equal(autoBidPrice(7.2, 720, terms), 720);
});

test("a store drivers keep reporting is skipped", () => {
  assert.equal(skipsStore(2, terms.rule), false);
  assert.equal(skipsStore(3, terms.rule), true);
});
