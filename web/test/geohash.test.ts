import assert from "node:assert/strict";
import { test } from "node:test";
import { distanceKm, encodeGeohash, geohashCenter } from "../src/lib/geohash.ts";

test("a cell's center encodes back to the same cell", () => {
  const stPete = { lat: 27.7676, lon: -82.6403 };
  const cell = encodeGeohash(stPete.lat, stPete.lon);
  const center = geohashCenter(cell);
  assert.equal(encodeGeohash(center.lat, center.lon), cell);
  // A precision-6 cell is about 1.2 x 0.6 km, so its center is well within a km.
  assert.ok(distanceKm(stPete, center) < 1);
});

test("rejects anything that isn't a geohash", () => {
  assert.throws(() => geohashCenter("abc!"), /not a geohash/);
});
