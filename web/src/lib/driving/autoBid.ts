// A driver's automatic bid on an order they're offered: their rate for the
// trip -- to the store, then on to the drop-off -- never under their lowest
// fee, and never over the customer's cap (an order capped below their price
// gets no bid). The ETAs are their usual estimate (`estimateTrip`).
import type { AutoBid } from "../../store/roleSettings";

export interface AutoBidTerms {
  rule: AutoBid;
  /// The lowest fee the driver takes, in minor units.
  minFeeCents: number;
}

/// The fee to bid for a trip of `tripKm`, or `null` if the customer's cap
/// (`capCents`) is below it.
export function autoBidPrice(tripKm: number, capCents: number | null, terms: AutoBidTerms): number | null {
  const price = Math.max(terms.minFeeCents, Math.ceil(tripKm * terms.rule.perKmCents), 1);
  return capCents !== null && price > capCents ? null : price;
}

/// Whether the driver's rule skips a store, by its drivers' reports of
/// refusing to check them in.
export function skipsStore(checkInRefusals: number, rule: AutoBid): boolean {
  return checkInRefusals >= rule.skipRefusals;
}
