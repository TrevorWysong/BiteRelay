// Sales tax and VAT, as `catalog_types::pricing::order_tax` computes them
// -- the cart shows what the order will cost, and the order is refused if
// the two ever disagree. Tested on the same cases as the Rust
// (test/tax.test.ts).
import type { TaxRate } from "../holochain/types";

/// One line as tax sees it: its tax category (empty for the store's first
/// rate) and what it costs before any promo.
export interface TaxableLine {
  category: string;
  total: number;
}

/// The tax in an order: each category's share of `foodTotal` (the food
/// after any promo, shared across lines by what each costs) at the store's
/// rate for it -- an unknown or empty category at the first rate -- rounded
/// half up per category. `included`: prices already contain it (VAT), and
/// this is the part that's tax; otherwise it's added on top.
export function orderTax(lines: TaxableLine[], foodTotal: number, rates: TaxRate[], included: boolean): number {
  const subtotal = lines.reduce((sum, l) => sum + BigInt(l.total), 0n);
  if (rates.length === 0 || subtotal === 0n) return 0;
  let tax = 0n;
  for (const category of [...new Set(lines.map((l) => l.category))]) {
    const rate = rates.find((r) => r.category === category) ?? rates[0];
    const bp = BigInt(rate.basis_points);
    const inCategory = lines.filter((l) => l.category === category).reduce((sum, l) => sum + BigInt(l.total), 0n);
    const taxable = (inCategory * BigInt(foodTotal)) / subtotal;
    if (included) {
      const denominator = 10_000n + bp;
      tax += taxable - (taxable * 10_000n + denominator / 2n) / denominator;
    } else {
      tax += (taxable * bp + 5_000n) / 10_000n;
    }
  }
  return Number(tax);
}

/// What the customer pays the store: the food, plus the tax unless prices
/// include it.
export function totalWithTax(foodTotal: number, tax: number, included: boolean): number {
  return included ? foodTotal : foodTotal + tax;
}

/// A rate as people read it: "8.25%".
export function percentLabel(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}
