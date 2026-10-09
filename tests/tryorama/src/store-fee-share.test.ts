// Proves the store pays its own share of the delivery fee -- with the
// customer, store and driver all different agents, the one case where the
// customer's conductor can't pay it: the customer's completion signals the
// store, whose conductor schedules the payment and makes it, with no client
// involved. The periodic sweep then finds nothing left, and paying twice is
// impossible.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, appSource, decodeEntry, retryUntil, retryUntilOk, ST_PETE, acceptOrder } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await scenario.addPlayersWithApps([{ appBundleSource: appSource }, { appBundleSource: appSource }, { appBundleSource: appSource }]);
  const all = [customer, merchant, driver];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  // The default split: the store covers half the delivery fee.
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Empanada", price_cents: 600, available: true }));
  await sync();

  const order = actionHash(
    await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity: 1 }], order_total: 600, dropoff: ST_PETE, max_delivery_fee: null, tip_cents: 100 }),
  );
  assert.equal(decodeEntry<{ delivery_subsidy_percent: number }>(await call(customer, "dispatch")<HcRecord>("get_order", order)).delivery_subsidy_percent, 50, "the order records the split it was placed under");
  await sync();
  await acceptOrder(merchant, order, all);
  const bid = actionHash(await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, price_offer: 500 }));
  await sync();
  await call(customer, "dispatch")("accept_bid", { order_original_action: order, bid_action: bid });
  await sync();
  await call(merchant, "dispatch")("set_order_status", { order_original_action: order, next_status: "MerchantConfirmed" });
  await sync();
  await call(driver, "dispatch")("set_order_status", { order_original_action: order, next_status: "DriverEnRouteToMerchant" });
  const handoff = async (sequence: number, kind: string, to: Uint8Array) => {
    const leg = actionHash(await call(driver, "attestation")<HcRecord>("record_leg", { order_ref: order, sequence, kind, to, geo_at_completion: ST_PETE }));
    await sync();
    const receipt = actionHash(await call(driver, "attestation")<HcRecord>("initiate_leg_attestation", leg));
    await retryUntilOk(() => call(driver, "attestation")("link_leg_to_receipt", { leg, receipt }));
  };
  await handoff(0, "MerchantHandoff", merchant.agentPubKey);
  await call(driver, "dispatch")("pick_up_order", order);
  await handoff(1, "CustomerHandoff", customer.agentPubKey);
  await sync();
  await call(customer, "dispatch")("complete_delivery", { order_original_action: order });
  await sync();
  console.log("[PASS] a delivery with three different agents is completed");

  // The customer pays the food, their half of the fee, and the tip; the
  // store's conductor pays its half itself, on the schedule the signal
  // started (the scheduler loop plus a retry -- allow up to a minute).
  const driverBalance = await retryUntil(
    () => call(driver, "ledger")<number>("get_balance", driver.agentPubKey),
    (balance) => balance === 600,
    120,
  );
  assert.equal(driverBalance, 600, "the driver gets the full $5.00 fee plus the $1.00 tip -- half the fee from the store");
  assert.equal(await call(customer, "ledger")<number>("get_balance", customer.agentPubKey), -(600 + 250 + 100), "the customer pays the food, half the fee and the tip");
  assert.equal(await call(merchant, "ledger")<number>("get_balance", merchant.agentPubKey), 600 - 250, "the store is paid for the food and pays its half of the fee");
  console.log("[PASS] the store's conductor pays its fee share when the completion signals it");

  const paid = await call(merchant, "dispatch")<number>("pay_outstanding_store_shares", null);
  assert.equal(paid, 0, "the fallback sweep finds nothing left to pay");
  await call(merchant, "dispatch")("pay_store_share", order);
  await sync();
  assert.equal(await call(driver, "ledger")<number>("get_balance", driver.agentPubKey), 600, "paying the share again changes nothing");
  console.log("[PASS] the sweep and a repeated payment are both no-ops once the share is paid");
});
