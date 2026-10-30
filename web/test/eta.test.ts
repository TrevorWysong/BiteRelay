import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTrip } from "../src/lib/driving/eta.ts";

const HERE = { lat: 27.7676, lon: -82.6403 };
// Just under 10km north.
const NORTH = { lat: 27.8575, lon: -82.6403 };
const NOW = 1_800_000_000_000;
const trip = { from: HERE, store: NORTH, dropoff: HERE, speedKmh: 20, readyBy: null, prepMinutes: null, nowMs: NOW };

test("an ETA is the trip to the store and on to the drop-off, at the driver's speed", () => {
  // 10km to the store, 10km back, at 20km/h: half an hour each way.
  assert.deepEqual(estimateTrip(trip), { toStoreMinutes: 30, etaMinutes: 60 });
});

test("a driver who'd arrive before the food is ready waits for it", () => {
  const readyIn45 = (NOW + 45 * 60_000) * 1000;
  // 30 minutes there, but the food's ready at 45; then 30 minutes on.
  assert.deepEqual(estimateTrip({ ...trip, readyBy: readyIn45 }), { toStoreMinutes: 30, etaMinutes: 75 });
});

test("before the kitchen starts, the food's ready its quoted prep time from now", () => {
  assert.deepEqual(estimateTrip({ ...trip, prepMinutes: 50 }), { toStoreMinutes: 30, etaMinutes: 80 });
});

test("an ETA is never under a minute", () => {
  assert.deepEqual(estimateTrip({ ...trip, store: HERE }), { toStoreMinutes: 1, etaMinutes: 1 });
});

test("a restaurant card's estimate: prep, any busy extra, and the trip, rounded, with a driver's spread", async () => {
  const { deliveryEstimate } = await import("../src/lib/driving/eta");
  const here = { lat: 27.7676, lon: -82.6403 };
  // ~5 km away at 25 km/h is 12 minutes; 15 prep + 12 = 27 -> 25.
  const near = deliveryEstimate({ location: { lat: 27.8126, lon: -82.6403 }, prep_minutes: 15, busy_extra_minutes: 0 }, here);
  assert.deepEqual([near.fromMinutes, near.toMinutes], [25, 35]);
  assert.ok(Math.abs(near.km - 5) < 0.1);
  const busy = deliveryEstimate({ location: here, prep_minutes: 15, busy_extra_minutes: 20 }, here);
  assert.deepEqual([busy.fromMinutes, busy.toMinutes], [35, 45], "a busy kitchen says so");
});

test("distances read in the local unit", async () => {
  const { formatDistance } = await import("../src/lib/ui/format");
  assert.equal(formatDistance(1.234, "en-US"), "0.8 mi");
  assert.equal(formatDistance(1.234, "en-GB"), "0.8 mi");
  assert.equal(formatDistance(1.234, "de-DE"), "1,2 km");
  assert.equal(formatDistance(12.6, "fr-FR"), "13 km");
});
