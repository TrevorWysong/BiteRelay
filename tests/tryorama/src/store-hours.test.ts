// Proves a store's hours and prep time: checkout refuses a store that's
// paused or outside its hours (in its own time zone), a store's conductor
// declines an order that slips past that, and accepting an order records
// when it'll be ready -- the store's usual prep time or the one it picks,
// which validation requires and bounds.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, appSource, decodeEntry, retryUntil, ST_PETE, useTestCoordinators, testApp, retryingCaller } from "./helpers.js";

const MINUTE = 60 * 1_000_000;

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([testApp, testApp]);
  const both = [customer, merchant];
  await scenario.shareAllAgents();
  // Each can write what a modified client could.
  await useTestCoordinators(customer, ["dispatch"]);
  await useTestCoordinators(merchant, ["dispatch"]);
  const sync = () => dhtSync(both, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE, time_zone: "UTC", prep_minutes: 12 }));
  const soup = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Soup", price_cents: 800, available: true }));
  const details = (fields: Record<string, unknown>) => ({
    original_action: store,
    description: "",
    cuisine_type: "",
    banner_data_uri: "",
    phone: "",
    address_street: "",
    address_city: "",
    address_state: "",
    address_zip: "",
    weekly_hours: [],
    time_zone: "UTC",
    prep_minutes: 12,
    max_delivery_radius_km: 8,
    ...fields,
  });
  await sync();
  const pickup = () => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: soup, quantity: 1 }], order_total: 800 });

  // --- Outside its hours, a store can't be ordered from. ---
  // Open only three days from now (UTC), 09:00-17:00.
  const today = new Date().getUTCDay();
  const otherDay = (today + 3) % 7;
  await call(merchant, "catalog")("update_catalog_details", details({ weekly_hours: [{ weekday: otherDay, opens: 540, closes: 1020 }] }));
  await sync();
  await assert.rejects(pickup(), /Mo's is closed then -- it next opens at 09:00/, "checkout refuses a store outside its hours");
  await assert.rejects(
    call(customer, "dispatch")("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: soup, quantity: 1 }], order_total: 800, dropoff: ST_PETE, max_delivery_fee: null }),
    /is closed then/,
    "deliveries too",
  );
  console.log("[PASS] checkout refuses a store outside its hours, read in its own time zone");

  // A store that's set to auto-accept declines an order that slipped past
  // the customer's own check, saying it's closed.
  await call(merchant, "catalog")("set_auto_accept_orders", { original_action: store, auto_accept_orders: true });
  await sync();
  const slipped = actionHash(
    await call(customer, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: customer.agentPubKey,
      merchant: merchant.agentPubKey,
      catalog_ref: store,
      catalog_version: store,
      lines: [{ item_ref: soup, priced_version: soup, quantity: 1 }],
      order_total: 800,
      status: "Placed",
      requested_at: Date.now() * 1000,
      kitchen_note: null,
      promo_code_ref: null,
      bag_claim_ref: null,
      loyalty_proof: [],
    }),
  );
  await sync();
  const declined = await retryUntil(
    async () => decodeEntry<{ status: string; cancellation: unknown }>(await call(customer, "dispatch")<HcRecord>("get_pickup_order", slipped)).cancellation,
    (cancellation) => cancellation !== null,
    90,
    1000,
  );
  assert.deepEqual(declined, { ByStore: "Closed" });
  console.log("[PASS] a store's conductor declines an order placed while it's closed");
  await call(merchant, "catalog")("set_auto_accept_orders", { original_action: store, auto_accept_orders: false });

  // --- Paused, it can't be ordered from whatever its hours. ---
  await call(merchant, "catalog")("update_catalog_details", details({ weekly_hours: [] }));
  await call(merchant, "catalog")("set_catalog_open", { original_action: store, is_open: false });
  await sync();
  await assert.rejects(pickup(), /Mo's isn't taking orders right now/);
  await call(merchant, "catalog")("set_catalog_open", { original_action: store, is_open: true });
  await sync();
  console.log("[PASS] a paused store takes no orders");

  // --- Accepting says when it'll be ready. ---
  const usual = actionHash(await pickup());
  await sync();
  const acceptedAt = Date.now() * 1000;
  const accepted = decodeEntry<{ ready_by: number }>(await call(merchant, "dispatch")<HcRecord>("accept_pickup_order", { order_original_action: usual }));
  assert.ok(Math.abs(accepted.ready_by - (acceptedAt + 12 * MINUTE)) < MINUTE, "the store's usual prep time");
  const picked = actionHash(await pickup());
  await sync();
  const pickedReady = decodeEntry<{ ready_by: number }>(await call(merchant, "dispatch")<HcRecord>("accept_pickup_order", { order_original_action: picked, prep_minutes: 30 })).ready_by;
  assert.ok(Math.abs(pickedReady - (Date.now() * 1000 + 30 * MINUTE)) < MINUTE, "or the time the kitchen picks");
  console.log("[PASS] accepting an order records when it'll be ready");

  // Validation requires that time, and bounds it.
  const forced = actionHash(await pickup());
  await sync();
  const force = (readyBy: number | null) =>
    call(merchant, "dispatch")("force_pickup_update_for_testing", { order_original_action: forced, next_status: "MerchantConfirmed", cancellation: null, ready_by: readyBy });
  await assert.rejects(force(null), /accepting an order must say when it'll be ready/);
  await assert.rejects(force(Date.now() * 1000 + 5 * 60 * MINUTE), /within the longest prep time the network allows/);
  await force(Date.now() * 1000 + 20 * MINUTE);
  console.log("[PASS] validation requires a ready time on acceptance, within the network's longest prep time");
});
