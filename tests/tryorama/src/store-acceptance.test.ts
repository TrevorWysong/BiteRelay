// Proves the store's sign-off can't be skipped, and that it's where an
// order pinned to an old price is stopped: an order reaches drivers only
// once its store accepts it, only the store can accept or prepare it
// (validation, not just the honest coordinator), and the store's
// acceptance refuses a line priced from an outdated menu.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, appSource, commitAndCook, decodeEntry, ST_PETE, testApp, useTestCoordinators, waitForSignal, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await scenario.addPlayersWithApps([testApp, testApp, testApp]);
  const all = [customer, merchant, driver];
  await scenario.shareAllAgents();
  // The customer can write what a modified client could.
  await useTestCoordinators(customer, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const status = async (p: typeof customer, fn: string, ref: Uint8Array) => decodeEntry<{ status: string }>(await call(p, "dispatch")<HcRecord>(fn, ref)).status;

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const burger = { catalog_ref: store, name: "Burger", price_cents: 1000, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [] };
  const burgerV1 = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", burger));
  await sync();

  // --- A delivery starts with the store, out of drivers' sight. ---
  const placed = await call(customer, "dispatch")<HcRecord>("request_delivery", {
    merchant: merchant.agentPubKey,
    catalog_ref: store,
    items: [{ item_ref: burgerV1, quantity: 1 }],
    order_total: 1000,
    dropoff: ST_PETE,
    max_delivery_fee: null,
  });
  const order = actionHash(placed);
  const { status: placedStatus, dropoff_geohash } = decodeEntry<{ status: string; dropoff_geohash: string }>(placed);
  assert.equal(placedStatus, "Placed");
  await sync();
  assert.equal((await call(driver, "dispatch")<HcRecord[]>("get_open_orders_near", dropoff_geohash)).length, 0, "drivers can't discover it");
  const bid = () => call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, price_offer: 400 });
  await assert.rejects(bid(), /isn't open for bids/, "or bid on it");
  console.log("[PASS] a placed delivery waits for its store, unseen by drivers");

  // --- Only the store can accept it. ---
  await assert.rejects(call(customer, "dispatch")("accept_delivery_order", { order_original_action: order }), /only the order's store can accept it/);
  await assert.rejects(
    call(customer, "dispatch")("force_order_update_for_testing", { order_original_action: order, next_status: "Open", delivery_receipts: [] }),
    /Placed -> Open requires author role Merchant/,
    "validation refuses a customer opening their own order, whatever their client does",
  );
  console.log("[PASS] a customer can't accept their own order, even by writing the update directly");

  // --- A price change racing an honest order is honoured... ---
  await call(merchant, "catalog")("update_menu_item", { original_action: burgerV1, item: { ...burger, price_cents: 1200 } });
  await sync();
  // The customer hears it, told what changed and as whom.
  const told = waitForSignal(customer.appWs as never, (p) => "OrderUpdated" in p, 30_000);
  assert.equal(decodeEntry<{ status: string }>(await acceptOrder(merchant, order, all)).status, "Open");
  const update = (await told)?.OrderUpdated;
  assert.deepEqual([update?.role, update?.change], ["Customer", { Delivery: { status: "Open", cancellation: null } }], "the customer is signalled the change, as the customer");
  assert.equal((await call(driver, "dispatch")<HcRecord[]>("get_open_orders_near", dropoff_geohash)).length, 1, "drivers see it once it's accepted");
  console.log("[PASS] the store accepts an order placed just before its price changed, and only then do drivers see it");

  // ...and once a driver has committed, only the store starts preparing it.
  const bidRef = actionHash(await bid());
  await sync();
  await call(customer, "dispatch")("accept_bid", { order_original_action: order, bid_action: bidRef });
  await sync();
  await assert.rejects(
    call(customer, "dispatch")("set_order_status", { order_original_action: order, next_status: "MerchantConfirmed" }),
    /Only the order's store cooks it/,
    "the customer can't confirm on the store's behalf",
  );
  await commitAndCook(driver, merchant, order, all);
  assert.equal(await status(merchant, "get_order", order), "MerchantConfirmed");
  console.log("[PASS] only the store confirms it's preparing a delivery");

  // --- Pickup: only the store accepts and readies it. ---
  const pickup = actionHash(
    await call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: burgerV1, quantity: 1 }], order_total: 1200 }),
  );
  await sync();
  await assert.rejects(call(customer, "dispatch")("accept_pickup_order", { order_original_action: pickup }), /only the order's store can accept it/, "a customer can't accept their own pickup");
  await assert.rejects(
    call(customer, "dispatch")("force_pickup_update_for_testing", { order_original_action: pickup, next_status: "MerchantConfirmed", cancellation: null }),
    /Placed -> MerchantConfirmed requires author role Merchant/,
    "even by writing the update directly",
  );
  await call(merchant, "dispatch")("accept_pickup_order", { order_original_action: pickup });
  await sync();
  await assert.rejects(call(customer, "dispatch")("mark_ready_for_pickup", pickup), /requires author role Merchant/, "or say it's ready");
  await call(merchant, "dispatch")("mark_ready_for_pickup", pickup);
  assert.equal(await status(merchant, "get_pickup_order", pickup), "ReadyForPickup");
  console.log("[PASS] only the store accepts a pickup and marks it ready");

  // --- An order pinned to an old price is refused. ---
  // Placed after the price went up, but priced from the version before it:
  // validation can't tell (it sees records as they were), the store can.
  const pinned = actionHash(
    await call(customer, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: customer.agentPubKey,
      merchant: merchant.agentPubKey,
      catalog_ref: store,
      catalog_version: store,
      lines: [{ item_ref: burgerV1, priced_version: burgerV1, quantity: 1 }],
      order_total: 1000,
      status: "Placed",
      requested_at: Date.now() * 1000,
      kitchen_note: null,
      promo_code_ref: null,
      bag_claim_ref: null,
      loyalty_proof: [],
    }),
  );
  await sync();
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: pinned }), /Burger was priced from an outdated menu/, "the store refuses it");
  await call(merchant, "dispatch")("decline_pickup_order", { order_original_action: pinned, reason: "OutdatedPrices" });
  assert.equal(await status(merchant, "get_pickup_order", pinned), "Cancelled");
  console.log("[PASS] the store refuses an order priced from an outdated menu, and declines it");
});
