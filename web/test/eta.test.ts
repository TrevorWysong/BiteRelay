import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTrip } from "../src/lib/eta.ts";

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
