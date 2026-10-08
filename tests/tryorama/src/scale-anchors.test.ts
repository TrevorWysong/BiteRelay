// Proves the time-bucketed anchor rewrite (architecture plan §9.2) didn't
// break ordinary discovery: a beacon/order published *now* still lands in
// the *current* bucket and is still found by get_nearby_providers/
// get_open_orders_near. This is deliberately a modest, 2-conductor test --
// it proves current-bucket read/write correctness live, not the fan-out cap
// under real density (that would need dozens of live driver conductors to
// exercise honestly; the cap's own truncation logic is instead unit-tested
// directly in matching.rs::tests, which is the right tool for a pure,
// deterministic Vec::truncate check). The bucket-boundary math itself
// (two timestamps far enough apart land in different buckets) is unit-
// tested in relay_types::tests::time_bucket_* -- also not something a live
// Tryorama test should try to prove via clock manipulation.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, driver] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const both = [customer, driver];

  const geoPresenceOf = (p: typeof customer) => getZomeCaller(p.cells[0], "geo_presence");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");

  await geoPresenceOf(driver)("announce_online", { location: ST_PETE, capabilities: ["Food"] });
  await dhtSync(both, customer.cells[0].cell_id[0]);

  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", {
    catalog_ref: catalogRef,
    name: "Empanada",
    price_cents: 600,
    available: true,
  });
  const menuItemRef = actionHash(menuItemRecord);

  const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: customer.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 600,
    dropoff: ST_PETE,
    max_delivery_fee: null,
  });
  const orderRef = actionHash(orderRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);

  // get_nearby_providers/get_open_orders_near take a geohash directly --
  // decode the order's own dropoff_geohash field rather than re-implementing
  // geohash encoding in the test, so this is guaranteed to be the exact
  // anchor cell the coordinator itself used.
  const order = decodeEntry<{ dropoff_geohash: string }>(orderRecord);

  const nearbyProviders = await geoPresenceOf(customer)<{ provider: Uint8Array }[]>("get_nearby_providers", order.dropoff_geohash);
  assert.equal(nearbyProviders.length, 1, "a beacon published now should be visible via the current-bucket anchor");
  console.log("[PASS] Current-bucket presence discovery still works after time-bucketing the anchor");

  const openOrders = await dispatchOf(driver)<HcRecord[]>("get_open_orders_near", order.dropoff_geohash);
  assert.equal(openOrders.length, 1, "an order created now should be visible via the current-bucket anchor");
  assert.deepEqual(actionHash(openOrders[0]), orderRef);
  console.log("[PASS] Current-bucket open-order polling backstop still works after time-bucketing the anchor");
});
