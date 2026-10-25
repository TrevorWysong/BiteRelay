// Regression tests for the October 2026 security audit: each block replays
// an attack the audit demonstrated against real conductors and proves
// validation now refuses it. Writes a modified client could make are done
// raw (test-utils).
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, appSource, decodeEntry, retryUntilOk, ST_PETE, useTestCoordinators, testApp, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [merchant, customer, attacker, driver] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
    testApp,
    testApp,
  ]);
  const all = [merchant, customer, attacker, driver];
  await scenario.shareAllAgents();
  for (const p of [attacker, customer]) await useTestCoordinators(p, ["catalog", "reputation", "dispatch"]);
  const sync = () => dhtSync(all, merchant.cells[0].cell_id[0]);
  const call = (p: typeof merchant, zome: string) => retryingCaller(p.cells[0], zome);
  const now = Date.now() * 1000;

  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(attacker, "profiles")("create_profile", { display_name: "Eve", roles: ["Merchant", "Provider"], created_at: now });
  const driverProfile = actionHash(await call(driver, "profiles")<HcRecord>("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now }));
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const soup = { catalog_ref: store, name: "Soup", price_cents: 1000, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [] };
  const soupRef = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", soup));
  const evesStore = actionHash(await call(attacker, "catalog")<HcRecord>("publish_catalog", { business_name: "Eve's", location: ST_PETE }));
  await sync();

  // --- Nobody changes another store's menu or details. ---
  await assert.rejects(
    call(attacker, "catalog")("update_menu_item", { original_action: soupRef, item: { ...soup, catalog_ref: evesStore, name: "HACKED", price_cents: 1 } }),
    /only a store's owner may change its menu items/,
    "through the app's own function",
  );
  const latest = decodeEntry<Record<string, unknown>>(await call(attacker, "catalog")<HcRecord>("get_catalog", store));
  await assert.rejects(
    call(attacker, "catalog")("update_raw_catalog_for_testing", { original_action: store, catalog: { ...latest, owner: attacker.agentPubKey, business_name: "CLOSED FOREVER", is_open: false } }),
    /only a store's owner may change it/,
    "nor with a modified client",
  );
  console.log("[PASS] nobody can change another store's menu items or details");

  // --- Images are inline, and bounded. ---
  await assert.rejects(call(attacker, "catalog")("update_catalog_details", { original_action: evesStore, description: "", cuisine_type: "", banner_data_uri: "https://tracker.example/pixel.png", phone: "", address_street: "", address_city: "", address_state: "", address_zip: "", weekly_hours: [], time_zone: "UTC", prep_minutes: 15, max_delivery_radius_km: 5 }), /inline PNG, JPEG, WebP or GIF/);
  await assert.rejects(call(attacker, "catalog")("add_menu_item", { ...soup, catalog_ref: evesStore, photo_data_uri: "data:image/svg+xml;base64,PHN2Zz4=" }), /inline PNG, JPEG, WebP or GIF/, "no SVG (it can carry script)");
  await assert.rejects(call(attacker, "catalog")("add_menu_item", { ...soup, catalog_ref: evesStore, name: "x".repeat(101) }), /at most 100 characters/);
  console.log("[PASS] an image can't be a remote link or an SVG, and text is bounded");

  // --- A driver's vehicle details are theirs alone, and nobody self-verifies. ---
  await assert.rejects(
    call(attacker, "profiles")("register_provider_credential", { profile_action: driverProfile, vehicle_description: "White van", capabilities: ["Food"], verified: false, license_plate: "EVIL1", photo_data_uri: "" }),
    /only publish vehicle details for their own profile/,
  );
  await assert.rejects(
    call(driver, "profiles")("register_provider_credential", { profile_action: driverProfile, vehicle_description: "Blue Civic", capabilities: ["Food"], verified: true, license_plate: "DANA1", photo_data_uri: "" }),
    /can't mark themselves verified/,
  );
  console.log("[PASS] only a driver publishes their vehicle details, and nobody marks themselves verified");

  // --- Nobody withdraws another driver's bid. ---
  const order = actionHash(
    await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: soupRef, quantity: 1 }], order_total: 1000, dropoff: ST_PETE, max_delivery_fee: null }),
  );
  await sync();
  await acceptOrder(merchant, order, all);
  const bidRecord = await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, price_offer: 400 });
  const bid = actionHash(bidRecord);
  await sync();
  const bidEntry = decodeEntry<Record<string, unknown>>(bidRecord);
  await assert.rejects(
    call(attacker, "dispatch")("update_raw_bid_for_testing", { original_action: bid, bid: { ...bidEntry, bidder: attacker.agentPubKey, status: "Withdrawn" } }),
    /only the bidder may update their own bid/,
  );
  console.log("[PASS] nobody can withdraw another driver's bid");

  // --- A rating is the sum of real reviews, one per customer per order. ---
  const item = actionHash(await retryUntilOk(() => call(merchant, "catalog")<HcRecord>("add_menu_item", { ...soup, name: "Stew" })));
  await sync();
  const pickup = actionHash(
    await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity: 1 }], order_total: 1000 })),
  );
  await sync();
  await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: pickup }));
  await call(merchant, "dispatch")("mark_ready_for_pickup", pickup);
  await sync();
  await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", pickup), 40);
  await sync();
  const review = actionHash(await retryUntilOk(() => call(customer, "reputation")<HcRecord>("submit_review", { target: { Store: store }, order_original_action: pickup, rating: 1, comment: "meh" })));
  await sync();
  // The rating rides on the link, checked against the review it points at.
  const fiveStars = new Uint8Array([5, ...pickup]);
  await assert.rejects(call(customer, "reputation")("test_create_link", { link_type: "StoreToReview", base: store, target: review, tag: Array.from(fiveStars) }), /must carry exactly what its entry says/);
  const rating = await retryUntilOk(async () => {
    const r = await call(merchant, "reputation")<{ count: number; rating_sum: number }>("get_rating_summary", { Store: store });
    assert.equal(r.count, 1);
    return r;
  });
  assert.equal(rating.rating_sum, 1, "one real one-star review is a one-star rating");
  console.log("[PASS] a rating can't be inflated by a forged link, and is the sum of real reviews");

  // --- Nobody records reputation about an order they weren't part of. ---
  await assert.rejects(
    call(attacker, "reputation")("record_event", { target: { Store: store }, order_ref: pickup, kind: "OrderCancelledByThem", basis: pickup }),
    /only the order's own parties record events about it/,
  );
  await assert.rejects(
    call(customer, "reputation")("record_event", { target: { Store: store }, order_ref: pickup, kind: "DisputeResolvedAgainst", basis: pickup }),
    /only its store an outcome/,
    "nor an outcome the store didn't decide",
  );
  console.log("[PASS] only an order's parties record events about it, and only its store an outcome");
});
