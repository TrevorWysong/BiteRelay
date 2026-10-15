// The same cases as catalog_types::pricing's tax tests -- keep them in step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { orderTax, percentLabel, totalWithTax } from "../src/lib/tax";

const rate = (category: string, basis_points: number) => ({ category, label: "", basis_points });
const taxed = (category: string, total: number) => ({ category, total });

test("tax on top rounds half up per category", () => {
  const rates = [rate("food", 825)];
  assert.equal(orderTax([taxed("food", 1000)], 1000, rates, false), 83);
  assert.equal(orderTax([taxed("food", 1000)], 1000, [], false), 0);
  assert.equal(totalWithTax(1000, 83, false), 1083);
});

test("each category at its rate, and unknown ones at the first", () => {
  const rates = [rate("prepared", 1000), rate("grocery", 0), rate("alcohol", 2000)];
  const lines = [taxed("prepared", 1000), taxed("grocery", 500), taxed("alcohol", 800), taxed("", 200)];
  assert.equal(orderTax(lines, 2500, rates, false), 280);
});

test("a promo lowers the tax, shared across lines", () => {
  const rates = [rate("prepared", 1000), rate("grocery", 0)];
  assert.equal(orderTax([taxed("prepared", 1000), taxed("grocery", 1000)], 1000, rates, false), 50);
});

test("included tax is the part of the price that's tax", () => {
  assert.equal(orderTax([taxed("standard", 1200)], 1200, [rate("standard", 2000)], true), 200);
  assert.equal(totalWithTax(1200, 200, true), 1200);
  assert.equal(orderTax([taxed("reduced", 1000)], 1000, [rate("reduced", 1000)], true), 91);
});

test("a rate reads as a percentage", () => {
  assert.equal(percentLabel(825), "8.25%");
  assert.equal(percentLabel(2000), "20%");
  assert.equal(percentLabel(550), "5.5%");
});

test("a store's report nets refunded tax out of what it collected", async () => {
  const { refundedTax, summarize } = await import("../src/lib/taxReport");
  assert.equal(refundedTax(500, 1083, 83), 38, "a refund carries its share of the tax");
  assert.equal(refundedTax(500, 0, 0), 0);
  const report = summarize([
    { placedAt: new Date(0), totalCents: 1083, taxCents: 83, refundedCents: 0, refundedTaxCents: 0 },
    { placedAt: new Date(1), totalCents: 2166, taxCents: 166, refundedCents: 1083, refundedTaxCents: 83 },
  ]);
  assert.deepEqual([report.salesCents, report.taxCents, report.refundedTaxCents, report.netTaxCents], [2166, 249, 83, 166]);
});
