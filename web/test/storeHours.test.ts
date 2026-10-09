// The same cases as catalog_types::hours's Rust tests, so the app and the
// zomes agree on when a store is open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeWeek, localWeekdayMinute, nextOpening, openAt, storeStatus } from "../src/lib/storeHours.ts";

const H = 60;
const period = (weekday: number, opens: number, closes: number) => ({ weekday, opens, closes });

test("no schedule means no set hours", () => {
  assert.ok(openAt([], 3, 2 * H));
  assert.equal(nextOpening([], 3, 0), null);
});

test("a daytime period is open from opening up to closing", () => {
  const schedule = [period(1, 8 * H, 22 * H)];
  assert.ok(!openAt(schedule, 1, 8 * H - 1));
  assert.ok(openAt(schedule, 1, 8 * H));
  assert.ok(openAt(schedule, 1, 22 * H - 1));
  assert.ok(!openAt(schedule, 1, 22 * H));
  assert.ok(!openAt(schedule, 2, 12 * H));
});

test("an overnight period runs into the next morning", () => {
  const schedule = [period(6, 18 * H, 2 * H)];
  assert.ok(openAt(schedule, 6, 23 * H));
  assert.ok(openAt(schedule, 0, H));
  assert.ok(!openAt(schedule, 0, 2 * H));
  assert.ok(!openAt(schedule, 6, 17 * H));
});

test("split shifts close between them", () => {
  const schedule = [period(2, 11 * H, 14 * H), period(2, 17 * H, 22 * H)];
  assert.ok(openAt(schedule, 2, 12 * H));
  assert.ok(!openAt(schedule, 2, 15 * H));
  assert.ok(openAt(schedule, 2, 18 * H));
});

test("next opening finds later today or a later day", () => {
  const schedule = [period(2, 11 * H, 14 * H), period(2, 17 * H, 22 * H), period(4, 9 * H, 17 * H)];
  assert.deepEqual(nextOpening(schedule, 2, 15 * H), { daysAhead: 0, minute: 17 * H });
  assert.deepEqual(nextOpening(schedule, 2, 23 * H), { daysAhead: 2, minute: 9 * H });
  assert.deepEqual(nextOpening(schedule, 4, 10 * H), { daysAhead: 5, minute: 11 * H });
});

// 2026-03-07 12:00 UTC, a Saturday: 07:00 in New York.
const SAT_NOON_UTC = new Date(Date.UTC(2026, 2, 7, 12, 0));

test("an instant is read in the store's own time zone", () => {
  assert.deepEqual(localWeekdayMinute("UTC", SAT_NOON_UTC), { weekday: 6, minute: 12 * H });
  assert.deepEqual(localWeekdayMinute("America/New_York", SAT_NOON_UTC), { weekday: 6, minute: 7 * H });
  assert.deepEqual(localWeekdayMinute("Not/AZone", SAT_NOON_UTC), { weekday: 6, minute: 12 * H }, "an unknown zone reads as UTC");
});

test("a store's status is worded for the customer", () => {
  const saturday = [period(6, 8 * H, 22 * H)];
  assert.deepEqual(storeStatus({ is_open: true, weekly_hours: saturday, time_zone: "UTC" }, SAT_NOON_UTC), { open: true, label: "Open until 10:00 PM" });
  assert.deepEqual(storeStatus({ is_open: true, weekly_hours: saturday, time_zone: "America/New_York" }, SAT_NOON_UTC), { open: false, label: "Closed · opens 8:00 AM" });
  assert.deepEqual(storeStatus({ is_open: false, weekly_hours: [], time_zone: "UTC" }, SAT_NOON_UTC), { open: false, label: "Not taking orders right now" });
  assert.deepEqual(storeStatus({ is_open: true, weekly_hours: [], time_zone: "UTC" }, SAT_NOON_UTC), { open: true, label: "Open" });
});

test("a week reads with matching days run together", () => {
  const weekdays = [1, 2, 3, 4, 5].map((day) => period(day, 8 * H, 22 * H));
  assert.deepEqual(describeWeek([...weekdays, period(6, 18 * H, 2 * H)]), [
    { days: "Mon–Fri", hours: "8:00 AM – 10:00 PM" },
    { days: "Sat", hours: "6:00 PM – 2:00 AM" },
    { days: "Sun", hours: "Closed" },
  ]);
});
