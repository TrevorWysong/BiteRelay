// Proves a real, previously-missing settlement: `complete_delivery` now
// actually pays the merchant for the food (`order_total`), not just the
// driver for delivering it. Uses three genuinely distinct agents (not the
// usual customer-doubles-as-merchant convention) specifically so this
// exercises the real cross-agent ledger transaction, not the from==to
// no-op skip added alongside it.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, collectFromStore, commitAndCook, handOff, retryUntil, ST_PETE, testApp, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
    testApp,
  ]);
  const all = [customer, merchant, driver];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => retryingCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => retryingCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => retryingCaller(p.cells[0], "dispatch");
  const ledgerOf = (p: typeof customer) => retryingCaller(p.cells[0], "ledger");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  // Isolate the order-total settlement from the delivery-fee split (already
  // covered by delivery-subsidy.test.ts) by zeroing the merchant's share.
  await catalogOf(merchant)("set_delivery_subsidy_percent", { original_action: catalogRef, delivery_subsidy_percent: 0 });
  const menuItemRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 600, available: true });
  const menuItemRef = actionHash(menuItemRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: merchant.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 600,
    dropoff: ST_PETE,
    max_delivery_fee: null,
    tip_cents: 100,
  });
  const orderRef = actionHash(orderRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await acceptOrder(merchant, orderRef, all);

  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRef,
    eta_seconds: 600,
    price_offer: 500,
  });
  const bidRef = actionHash(bidRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await commitAndCook(driver, merchant, orderRef, all);

  await collectFromStore(driver, merchant, orderRef, all);

  await handOff(driver, customer, orderRef, "CustomerHandoff", all);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await dispatchOf(customer)("complete_delivery", { order_original_action: orderRef });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const merchantBalance = await retryUntil(() => ledgerOf(merchant)<number>("get_balance", merchant.agentPubKey), (b) => b === 600, 120, 1000);
  assert.equal(merchantBalance, 600, "merchant should now actually be paid order_total ($6.00) for the food");

  const driverBalance = await retryUntil(() => ledgerOf(driver)<number>("get_balance", driver.agentPubKey), (b) => b === 600, 120, 1000);
  assert.equal(driverBalance, 600, "driver should still be paid the full $5.00 bid + $1.00 tip, unaffected by the new order-total settlement");

  const customerBalance = await retryUntil(() => ledgerOf(customer)<number>("get_balance", customer.agentPubKey), (b) => b === -1200, 120, 1000);
  assert.equal(customerBalance, -1200, "customer should be debited both legs: $6.00 for food + $6.00 for delivery fee/tip");

  console.log("[PASS] complete_delivery now settles order_total to a genuinely distinct merchant, alongside the existing delivery-fee/tip settlement to the driver");
});
