// Sanity check for the user's own live report: "my address is only 1
// house away from the restaurant but Browse says 0 restaurants near me."
// Proves (or disproves) that get_nearby_merchants' own geohash
// cell_and_neighbors walk actually finds a catalog from a customer
// location genuinely one house-lot away (~20m, not a loose "same city"
// test) -- isolating whether this is a backend discovery bug or a
// frontend/session-state issue on the user's own running instance.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { decodeEntry, testApp, retryingCaller } from "./helpers.js";

// Real coordinates near Taunton, MA (the address mentioned in the bug
// report), ~20m apart -- a genuine "next house over" delta, not a loose
// "same metro area" one. 1 degree latitude is ~111km everywhere; 1 degree
// longitude at this latitude (~42N) is ~82.5km.
const RESTAURANT = { lat: 41.9035, lon: -71.0898 };
const ONE_HOUSE_AWAY = { lat: 41.90368, lon: -71.08992 }; // ~20m north

await runScenario(async (scenario) => {
  const [merchant, customer] = await scenario.addPlayersWithApps([testApp, testApp]);
  const all = [merchant, customer];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof merchant) => retryingCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof merchant) => retryingCaller(p.cells[0], "catalog");

  const now = Date.now() * 1000;
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: RESTAURANT });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const merchantGeohash = decodeEntry<{ geohash: string }>(catalogRecord).geohash;
  console.log(`[INFO] merchant's own precision-6 geohash: ${merchantGeohash}`);

  // Mirrors web/src/lib/places/geohash.ts's encodeGeohash exactly (same algorithm,
  // precision 6) -- this test has to derive the *customer's* geohash the
  // same way the real frontend does, not just reuse the merchant's.
  function encodeGeohash(lat: number, lon: number, precision = 6): string {
    const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
    let latRange = [-90, 90];
    let lonRange = [-180, 180];
    let hash = "";
    let bit = 0;
    let ch = 0;
    let evenBit = true;
    while (hash.length < precision) {
      if (evenBit) {
        const mid = (lonRange[0] + lonRange[1]) / 2;
        if (lon > mid) { ch |= 1 << (4 - bit); lonRange[0] = mid; } else { lonRange[1] = mid; }
      } else {
        const mid = (latRange[0] + latRange[1]) / 2;
        if (lat > mid) { ch |= 1 << (4 - bit); latRange[0] = mid; } else { latRange[1] = mid; }
      }
      evenBit = !evenBit;
      if (bit < 4) { bit++; } else { hash += BASE32[ch]; bit = 0; ch = 0; }
    }
    return hash;
  }

  const customerGeohash = encodeGeohash(ONE_HOUSE_AWAY.lat, ONE_HOUSE_AWAY.lon);
  console.log(`[INFO] customer's own precision-6 geohash (~20m away): ${customerGeohash}`);

  const page = await catalogOf(customer)<{ catalogs: { original_action: Uint8Array; record: HcRecord }[] }>("get_nearby_merchants", {
    geohash: customerGeohash,
    after: null,
  });
  assert.equal(page.catalogs.length, 1, `expected the ~20m-away customer to discover the merchant via cell_and_neighbors, got ${page.catalogs.length} results (merchant cell ${merchantGeohash}, customer cell ${customerGeohash})`);
  console.log("[PASS] get_nearby_merchants finds a merchant from a customer location genuinely one house-lot away");
  console.log(merchantGeohash === customerGeohash ? "[INFO] both landed in the exact same precision-6 cell" : "[INFO] landed in different but presumably-neighboring precision-6 cells");
});
