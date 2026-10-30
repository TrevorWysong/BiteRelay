// A driver's earnings, from their own ledger -- every fee, tip and late
// cover they collected, the collateral they forfeited, and what they cashed
// out -- grouped by week or month. Read on this device, from records only
// they wrote: there's no report anyone else keeps.
import type { LedgerEntry } from "../../holochain/types";
import { bytesToHex } from "../../holochain/decode";

export interface LedgerRow {
  hash: Uint8Array;
  entry: LedgerEntry;
  /// Microseconds since the epoch.
  at: number;
}

export interface EarningsPeriod {
  /// The period's first day, local midnight, in milliseconds.
  start: number;
  deliveries: number;
  fees: number;
  tips: number;
  /// What stores paid for keeping the driver waiting.
  lateCover: number;
  /// Collateral conceded on orders that never arrived.
  forfeited: number;
  cashedOut: number;
}

export type Grouping = "week" | "month";

/// The local midnight starting `at`'s week (from Monday) or month.
export function periodStart(atMs: number, grouping: Grouping): number {
  const d = new Date(atMs);
  d.setHours(0, 0, 0, 0);
  if (grouping === "month") d.setDate(1);
  else d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/// Earnings by period, newest first.
export function earningsByPeriod(rows: LedgerRow[], grouping: Grouping): EarningsPeriod[] {
  // Holds the driver paid themselves: a collection from one is money back
  // (a refund as a customer, collateral returned), not earnings.
  const mine = new Map<string, LedgerRow>();
  for (const row of rows) if ("Hold" in row.entry.kind) mine.set(bytesToHex(row.hash), row);

  const periods = new Map<number, EarningsPeriod & { holds: Set<string> }>();
  const period = (at: number) => {
    const start = periodStart(at / 1000, grouping);
    let p = periods.get(start);
    if (!p) periods.set(start, (p = { start, deliveries: 0, fees: 0, tips: 0, lateCover: 0, forfeited: 0, cashedOut: 0, holds: new Set() }));
    return p;
  };
  for (const row of rows) {
    const kind = row.entry.kind;
    if ("Collect" in kind) {
      const hold = bytesToHex(kind.Collect.hold);
      if (mine.has(hold)) continue;
      const p = period(row.at);
      if (kind.Collect.portion === "Fee") {
        p.fees += row.entry.amount;
        p.holds.add(hold);
      } else if (kind.Collect.portion === "Tip") p.tips += row.entry.amount;
      else if (kind.Collect.portion === "LateCover") p.lateCover += row.entry.amount;
    } else if ("Forfeit" in kind) {
      period(row.at).forfeited += mine.get(bytesToHex(kind.Forfeit.hold))?.entry.amount ?? 0;
    } else if ("Redeem" in kind) {
      period(row.at).cashedOut += row.entry.amount;
    }
  }
  return [...periods.values()]
    .map(({ holds, ...p }) => ({ ...p, deliveries: holds.size }))
    .sort((a, b) => b.start - a.start);
}

export const earned = (p: EarningsPeriod) => p.fees + p.tips + p.lateCover;

/// The periods as CSV, for the driver's own records or their accountant.
export function earningsCsv(periods: EarningsPeriod[], grouping: Grouping, minor: (cents: number) => string): string {
  const header = [grouping === "week" ? "Week starting" : "Month", "Deliveries", "Fees", "Tips", "Late cover", "Earned", "Collateral forfeited", "Cashed out"];
  const day = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const lines = periods.map((p) => [day(p.start), p.deliveries, minor(p.fees), minor(p.tips), minor(p.lateCover), minor(earned(p)), minor(p.forfeited), minor(p.cashedOut)].join(","));
  return [header.join(","), ...lines].join("\n") + "\n";
}
