// A driver's earnings come from their own ledger: fees, tips and late
// cover they collected -- never money back from holds they paid -- by
// week or month.
import assert from "node:assert/strict";
import { test } from "node:test";
import { earned, earningsByPeriod, earningsCsv, periodStart, type LedgerRow } from "../src/lib/earnings";
import type { LedgerEntry } from "../src/holochain/types";

const h = (n: number) => new Uint8Array(39).fill(n);
const at = (iso: string) => new Date(iso).getTime() * 1000;
const row = (n: number, when: string, kind: LedgerEntry["kind"], amount: number): LedgerRow => ({ hash: h(n), at: at(when), entry: { kind, amount, balance: 0, in_hand: { orders: 0, priority: false }, previous: null } as unknown as LedgerEntry });
const collect = (hold: number, portion: string) => ({ Collect: { hold: h(hold), portion, basis: h(99) } }) as unknown as LedgerEntry["kind"];

test("fees, tips and late cover by week; money back from one's own holds isn't earnings", () => {
  const rows = [
    row(1, "2026-10-05T12:00:00", collect(50, "Fee"), 600),
    row(2, "2026-10-05T12:00:00", collect(50, "Tip"), 200),
    row(3, "2026-10-07T18:00:00", collect(51, "Fee"), 500),
    row(4, "2026-10-07T18:00:00", collect(52, "LateCover"), 300),
    // Their collateral hold, returned: not earnings.
    row(10, "2026-10-07T17:00:00", { Hold: { order: h(70), purpose: { Collateral: { bid: h(71) } } } } as unknown as LedgerEntry["kind"], 1500),
    row(11, "2026-10-07T19:00:00", collect(10, "Collateral"), 1500),
    // Next week: another delivery, a forfeited collateral, a cash-out.
    row(12, "2026-10-13T09:00:00", { Hold: { order: h(72), purpose: { Collateral: { bid: h(73) } } } } as unknown as LedgerEntry["kind"], 900),
    row(13, "2026-10-13T10:00:00", { Forfeit: { hold: h(12), basis: h(98) } } as unknown as LedgerEntry["kind"], 0),
    row(14, "2026-10-14T10:00:00", collect(53, "Fee"), 700),
    row(15, "2026-10-15T10:00:00", { Redeem: { issuer: h(80), instructions: null } } as unknown as LedgerEntry["kind"], 2000),
  ];
  const [later, earlier] = earningsByPeriod(rows, "week");
  assert.deepEqual([earlier.deliveries, earlier.fees, earlier.tips, earlier.lateCover, earned(earlier)], [2, 1100, 200, 300, 1600]);
  assert.deepEqual([later.deliveries, later.fees, later.forfeited, later.cashedOut], [1, 700, 900, 2000]);
  assert.equal(earlier.start, periodStart(new Date("2026-10-05T00:00:00").getTime(), "week"), "weeks start on Monday");

  const [month] = earningsByPeriod(rows, "month");
  assert.equal(month.deliveries, 3);
  const csv = earningsCsv([earlier], "week", (c) => (c / 100).toFixed(2));
  assert.equal(csv.split("\n")[1], "2026-10-05,2,11.00,2.00,3.00,16.00,0.00,0.00");
});
