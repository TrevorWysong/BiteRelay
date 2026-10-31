// The app's preview of what an order earns must agree with the rules
// validation enforces (rewards_types::points) -- the same cases run there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { earnedFor, localTime, nextTier, orderPoints, tierOf } from "../src/lib/rewards/rewards.ts";
import type { PointsState, RewardsProgram } from "../src/holochain/types.ts";

const hash = (n: number) => new Uint8Array(39).fill(n);
/// 2026-06-15 (a Monday) at `hour`:00 in New York.
const june = (hour: number) => (1_781_496_000 + hour * 3600) * 1_000_000;

function program(): RewardsProgram {
  return {
    catalog_ref: hash(1),
    active: true,
    name: "Mo's Rewards",
    points_name: "points",
    tagline: "",
    accent: "Ember",
    earn: { points_per_dollar: 10, min_order_cents: 0, max_per_order: null, welcome_bonus: 0, item_bonuses: [], happy_hours: [] },
    tiers: [],
    rewards: [],
    birthday_points: 0,
    expiry_days: null,
    max_balance: null,
    time_zone: "America/New_York",
  };
}
const state = (s: Partial<PointsState>): PointsState => ({ balance: 0, year: 2026, earned_this_year: 0, earned_last_year: 0, lifetime_earned: 0, orders: 1, first_earned_at: null, last_earned_at: null, ...s });

test("local time follows the program's zone", () => {
  assert.deepEqual(localTime(june(12), "America/New_York"), { year: 2026, weekday: 0, minute: 12 * 60 });
  assert.equal(localTime(june(12), "Nowhere/Atall").minute, 16 * 60, "an unknown zone is UTC");
});

test("an order earns its food at the rate", () => {
  const p = program();
  const soup = { itemRef: hash(9), totalCents: 1000 };
  assert.equal(orderPoints(p, [soup], 1000, june(12)), 100);
  assert.equal(orderPoints(p, [soup], 999, june(12)), 99, "rounded down");
  assert.equal(orderPoints({ ...p, earn: { ...p.earn, min_order_cents: 1500 } }, [soup], 1000, june(12)), 0, "below the minimum");
});

test("bonus items and happy hours earn faster", () => {
  const p = program();
  p.earn.item_bonuses = [{ item_ref: hash(9), percent: 300 }];
  const lines = [
    { itemRef: hash(9), totalCents: 500 },
    { itemRef: hash(8), totalCents: 500 },
  ];
  assert.equal(orderPoints(p, lines, 800, june(12)), 40 * 3 + 40);
  p.earn.happy_hours = [
    { days: 1, start_minute: 11 * 60, end_minute: 14 * 60, percent: 200 },
    { days: 1, start_minute: 12 * 60, end_minute: 13 * 60, percent: 150 },
  ];
  assert.equal(orderPoints(p, lines, 800, june(12)), (40 * 3 + 40) * 2, "the best hour that applies");
  assert.equal(orderPoints(p, lines, 800, june(14)), 40 * 3 + 40, "an hour ends where it says");
  assert.equal(orderPoints(p, lines, 800, june(12) + 86_400_000_000), 40 * 3 + 40, "only on its days");
});

test("the welcome, the cap and the tier", () => {
  const p = program();
  p.earn.welcome_bonus = 50;
  p.earn.max_per_order = 200;
  assert.equal(earnedFor(p, null, 500), 250, "capped at 200, then the welcome");
  assert.equal(earnedFor(p, state({ orders: 1 }), 100), 100, "no second welcome");
  assert.equal(earnedFor(p, null, 0), 0, "an order earning nothing isn't welcomed");
  p.tiers = [{ name: "Gold", threshold: 1000, percent: 150, perk: "" }];
  p.earn.max_per_order = null;
  assert.equal(tierOf(p, state({ earned_last_year: 1000 })), 1, "kept through the next year");
  assert.equal(earnedFor(p, state({ earned_this_year: 1000 }), 100), 150);
  assert.deepEqual(nextTier(p, state({ earned_this_year: 250 })), { index: 1, name: "Gold", needed: 750, progress: 0.25 });
  assert.equal(nextTier(p, state({ earned_this_year: 1000 })), null, "at the top");
});
