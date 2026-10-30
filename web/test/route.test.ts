import assert from "node:assert/strict";
import { test } from "node:test";
import { planRoute } from "../src/lib/driving/route.ts";

const at = (lat: number, lon: number) => ({ lat, lon });
const order = (stops: { kind: string; id: string }[]) => stops.map((s) => `${s.kind}:${s.id}`);

test("collects both pickups at a shared store, then drops off nearest first", () => {
  const stops = planRoute(at(0, 0), [
    { id: "a", pickup: at(0, 0.01), dropoff: at(0, 0.05) },
    { id: "b", pickup: at(0, 0.01), dropoff: at(0, 0.03) },
  ]);
  assert.deepEqual(order(stops), ["pickup:a", "pickup:b", "dropoff:b", "dropoff:a"]);
});

test("never drops off before picking up, even when the drop-off is closest", () => {
  const stops = planRoute(at(0, 0), [{ id: "x", pickup: at(0, 0.1), dropoff: at(0, 0.001) }]);
  assert.deepEqual(order(stops), ["pickup:x", "dropoff:x"]);
});

test("an order already picked up only needs its drop-off", () => {
  const stops = planRoute(at(0, 0), [{ id: "y", pickup: null, dropoff: at(0, 0.02) }]);
  assert.deepEqual(order(stops), ["dropoff:y"]);
  // 0.02 degrees of longitude at the equator is about 2.2 km.
  assert.ok(stops[0].legKm > 2 && stops[0].legKm < 2.5);
});

test("no deliveries, no stops", () => {
  assert.deepEqual(planRoute(at(0, 0), []), []);
});
