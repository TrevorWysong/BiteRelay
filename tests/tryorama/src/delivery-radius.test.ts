// Proves a store's delivery radius holds: `request_delivery` refuses a
// drop-off past it (for a cart order and a goodie-bag delivery alike), and
// validation refuses an order a modified client writes anyway -- every
// order cites the store version it was placed under (`catalog_version`),
// and its public drop-off area must lie within that version's radius, its
// fee split be that version's, and its sealed notes stay small.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, decodeEntry, limits, ST_PETE, NYC, testApp, useTestCoordinators } from "./helpers.js";

await runScenario(async (scenario) => {
  const [merchant, customer, otherMerchant] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
    testApp,
  ]);
  const all = [merchant, customer, otherMerchant];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof merchant) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof merchant) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof merchant) => getZomeCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", {
    business_name: "Mo's Kitchen",
    location: ST_PETE,
    max_delivery_radius_km: 5,
  });
  const catalogRef = actionHash(catalogRecord);
  assert.equal(decodeEntry<{ max_delivery_radius_km: number }>(catalogRecord).max_delivery_radius_km, 5);
  console.log("[PASS] publish_catalog accepts and stores a custom max_delivery_radius_km");

  const menuItemRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", {
    catalog_ref: catalogRef,
    name: "Cuban Sandwich",
    price_cents: 1250,
    available: true,
  });
  const menuItemRef = actionHash(menuItemRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // Within radius -- dropoff is the merchant's own pickup point, distance 0.
  const orderInRange = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: merchant.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 1250,
    dropoff: ST_PETE,
    max_delivery_fee: 500,
  });
  assert.ok(actionHash(orderInRange));
  console.log("[PASS] request_delivery succeeds for a dropoff within the merchant's delivery radius");

  // Outside radius -- NYC is ~1700km from St. Petersburg, FL, far past the 5km cap.
  await assert.rejects(
    dispatchOf(customer)("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: menuItemRef, quantity: 1 }],
      order_total: 1250,
      dropoff: NYC,
      max_delivery_fee: 500,
    }),
    /past this store's .*delivery radius/,
    "a dropoff far past the merchant's own delivery radius must be rejected",
  );
  console.log("[PASS] request_delivery rejects a dropoff outside the merchant's delivery radius");

  // Same enforcement point also covers a goodie-bag delivery claim
  // finalizing into a DeliveryOrder -- bag deliveries flow through this
  // exact same request_delivery call, not a separate path.
  const bagRecord = await catalogOf(merchant)<HcRecord>("create_goodie_bag", {
    catalog_ref: catalogRef,
    title: "End-of-day goodie bag",
    description: "",
    photo_data_uri: "",
    original_value_cents: 1500,
    price_cents: 500,
    quantity_total: 1,
    pickup_window_start: now + 1_000_000,
    pickup_window_end: now + 7_200_000_000,
    supports_pickup: false,
    supports_delivery: true,
    created_at: now,
  });
  const bagRef = actionHash(bagRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const claimRecord = await catalogOf(customer)<HcRecord>("claim_goodie_bag", {
    bag_ref: bagRef,
    fulfillment: { Delivery: { dropoff: NYC, max_delivery_fee: 300 } },
  });
  const claimRef = actionHash(claimRecord);
  await dhtSync(all, merchant.cells[0].cell_id[0]);
  const confirmedClaim = actionHash(await catalogOf(merchant)<HcRecord>("confirm_claim", claimRef));
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await assert.rejects(
    dispatchOf(customer)("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: bagRef, quantity: 1 }],
      order_total: 500,
      dropoff: NYC,
      max_delivery_fee: 300,
      bag_claim_ref: confirmedClaim,
    }),
    /past this store's .*delivery radius/,
    "a confirmed goodie-bag claim must still respect the merchant's delivery radius when finalized",
  );
  console.log("[PASS] request_delivery rejects a confirmed goodie-bag claim's out-of-radius dropoff too");

  // A catalog published before this field existed (or one that simply
  // omits it) should still work, defaulting to 8km -- never a hard
  // deserialize failure, the same posture every other additive field in
  // this app already has.
  await profilesOf(otherMerchant)("create_profile", { display_name: "Other Merchant", roles: ["Merchant"], created_at: now });
  const defaultCatalogRecord = await catalogOf(otherMerchant)<HcRecord>("publish_catalog", {
    business_name: "Otto's Kitchen",
    location: ST_PETE,
  });
  assert.equal(decodeEntry<{ max_delivery_radius_km: number }>(defaultCatalogRecord).max_delivery_radius_km, 8);
  console.log("[PASS] omitting max_delivery_radius_km from publish_catalog defaults to 8km, not a deserialize error");

  // ===== What validation holds an order to =====
  await useTestCoordinators(customer, ["dispatch"]);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const forged = (fields: Record<string, unknown>) => dispatchOf(customer)("create_raw_delivery_order_for_testing", { template: actionHash(orderInRange), ...fields });
  const honest = decodeEntry<{ catalog_version: Uint8Array; dropoff_geohash: string }>(orderInRange);
  assert.equal(honest.dropoff_geohash.length, 6, "an order publishes its drop-off's area, not its point");
  await assert.rejects(forged({ dropoff_geohash: "dr5reg" }), /outside the store's delivery radius/, "a drop-off in New York, for a store in St. Petersburg");
  await assert.rejects(forged({ dropoff_geohash: honest.dropoff_geohash.slice(0, 4) }), /geohash of 6 characters/, "nor a vaguer area, which could stretch the radius");
  await assert.rejects(forged({ catalog_version: actionHash(defaultCatalogRecord) }), /version of the order's own store/, "an order cites its own store's terms, not another's");
  await assert.rejects(forged({ delivery_subsidy_percent: 0 }), /fee split is its store's/, "nor a fee split the store never set");
  await assert.rejects(forged({ kitchen_note_bytes: limits.MAX_SEALED_BYTES + 1 }), /kitchen_note is too large/, "a sealed note stays small");
  assert.ok(await forged({}), "the honest order's own copy is still valid");
  console.log("[PASS] validation holds every order to its store's radius, fee split and size limits");

  console.log("[PASS] delivery radius enforcement test complete");
});
