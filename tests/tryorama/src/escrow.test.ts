// Proves escrow end to end, with the customer, store and driver all
// different agents: each step of a delivery sets aside what its author owes
// for it, in the same commit (and the next step can't happen without it);
// nothing moves to anyone until the customer confirms the delivery, and then
// each party's own conductor collects what it's owed. A cancellation hands
// back what nobody earned: everything before the store accepts; once a
// driver is assigned, the driver keeps the customer's share of the fee, and
// once the store is cooking, the store keeps the food.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, appSource, collectFromStore, commitAndCook, handOff, retryUntil, retryUntilOk, ST_PETE, testApp } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await scenario.addPlayersWithApps([testApp, testApp, testApp]);
  const all = [customer, merchant, driver];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);
  const balance = (p: typeof customer) => call(p, "ledger")<number>("get_balance", p.agentPubKey);
  const settled = (p: typeof customer, expected: number) => retryUntil(() => balance(p), (b) => b === expected, 120, 1000);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  // The store covers half the delivery fee (the default).
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 2000, available: true }));
  await sync();
  const placeOrder = async () => {
    const order = actionHash(
      await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity: 1 }], order_total: 2000, dropoff: ST_PETE, max_delivery_fee: null, tip_cents: 300 }),
    );
    await sync();
    return order;
  };
  const assignDriver = async (order: Uint8Array) => {
    await acceptOrder(merchant, order, all);
    const bid = actionHash(await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, price_offer: 500 }));
    await sync();
    await call(customer, "dispatch")("accept_bid", { order_original_action: order, bid_action: bid });
    await sync();
  };

  // --- A delivery, step by step. ---
  const order = await placeOrder();
  assert.equal(await balance(customer), -2000, "placing the order holds the food");
  await assignDriver(order);
  assert.equal(await balance(customer), -(2000 + 250 + 300), "accepting a bid holds the customer's half of the fee and the tip");
  await commitAndCook(driver, merchant, order, all);
  assert.equal(await balance(driver), -2000, "committing holds the driver's collateral, the value of the food");
  assert.equal(await balance(merchant), 0, "the store holds nothing until it checks the driver in");
  await collectFromStore(driver, merchant, order, all);
  assert.equal(await balance(merchant), -(250 + 250), "checking the driver in holds the store's half of the fee, and the customer's half again in case it keeps them waiting");
  await sync();
  for (const p of all) assert.equal(await call(p, "dispatch")<number>("settle_order", order), 0, "nothing is owed to anyone before the customer has the order");
  console.log("[PASS] each step holds what its author owes, and nothing moves before the delivery");

  await handOff(driver, customer, order, "CustomerHandoff", all);
  await retryUntilOk(() => call(customer, "dispatch")("complete_delivery", { order_original_action: order }));
  await sync();
  assert.equal(await settled(driver, 500 + 300), 500 + 300, "the driver collects the whole fee and the tip, and their collateral back");
  assert.equal(await settled(merchant, 2000 - 250), 2000 - 250, "the store collects the food");
  assert.equal(await balance(customer), -(2000 + 250 + 300));
  console.log("[PASS] once the customer confirms, each party's conductor collects what it's owed");

  // --- A customer cancelling before the store accepts gets everything back. ---
  const [customerBefore, merchantBefore] = [await balance(customer), await balance(merchant)];
  const early = await placeOrder();
  assert.equal(await balance(customer), customerBefore - 2000);
  await call(customer, "dispatch")("cancel_order", early);
  await sync();
  // The store's conductor waives the food; the customer's collects it back.
  assert.equal(await settled(customer, customerBefore), customerBefore, "the food comes back");
  assert.equal(await balance(merchant), merchantBefore, "the store gets nothing");
  console.log("[PASS] cancelling before the store accepts returns everything");

  // --- With a driver assigned but nothing cooking, only the driver's fee is owed. ---
  const [c0, m0, d0] = [await balance(customer), await balance(merchant), await balance(driver)];
  const assigned = await placeOrder();
  await assignDriver(assigned);
  await retryUntilOk(() => call(customer, "dispatch")("cancel_order", assigned));
  await sync();
  assert.equal(await settled(customer, c0 - 250), c0 - 250, "the food and the tip come back: the store hadn't started");
  assert.equal(await settled(driver, d0 + 250), d0 + 250, "the driver keeps the customer's half of the fee");
  assert.equal(await balance(merchant), m0, "the store is owed nothing");
  console.log("[PASS] cancelling before the store cooks costs only the driver's fee");

  // --- Once it's cooking, the store keeps the food too. ---
  const [c1, m1, d1] = [await balance(customer), await balance(merchant), await balance(driver)];
  const late = await placeOrder();
  await assignDriver(late);
  await commitAndCook(driver, merchant, late, all);
  await retryUntilOk(() => call(customer, "dispatch")("cancel_order", late));
  await sync();
  assert.equal(await settled(merchant, m1 + 2000), m1 + 2000, "the store keeps the food");
  assert.equal(await settled(driver, d1 + 250), d1 + 250, "the driver keeps the customer's half of the fee, and their collateral comes back");
  assert.equal(await settled(customer, c1 - 2000 - 250), c1 - 2000 - 250, "the tip comes back to the customer");
  console.log("[PASS] a late cancellation pays the store and driver for what they'd committed, and returns the rest");
});
