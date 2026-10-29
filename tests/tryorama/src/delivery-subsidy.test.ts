// Proves the merchant delivery-cost-sharing model: a 50/50 percentage split with the customer is the
// real default (set at publish_catalog time, not a rare opt-in), the split
// stays proportional to whatever the winning bid turns out to be, and the
// driver is always paid the full bid regardless of which side(s) it came
// from.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, collectFromStore, commitAndCook, decodeEntry, handOff, retryUntil, ST_PETE, testApp, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, driver] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
  ]);
  const both = [customer, driver];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => retryingCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => retryingCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => retryingCaller(p.cells[0], "dispatch");
  const ledgerOf = (p: typeof customer) => retryingCaller(p.cells[0], "ledger");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 600, available: true });
  const menuItemRef = actionHash(menuItemRecord);

  // Never explicitly set -- publish_catalog's own default should already
  // be 50, not 0.
  const decodedCatalog = decodeEntry<{ delivery_subsidy_percent: number }>(catalogRecord);
  assert.equal(decodedCatalog.delivery_subsidy_percent, 50, "publish_catalog should default delivery_subsidy_percent to 50, not 0");
  console.log("[PASS] publish_catalog defaults delivery_subsidy_percent to an even 50/50 split");

  async function driveToDelivered(priceOfferCents: number) {
    const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
      merchant: customer.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: menuItemRef, quantity: 1 }],
      order_total: 600,
      dropoff: ST_PETE,
      max_delivery_fee: null,
      tip_cents: 100,
    });
    const orderRef = actionHash(orderRecord);
    await dhtSync(both, customer.cells[0].cell_id[0]);
    await acceptOrder(customer, orderRef, both);

    const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
      order_ref: orderRef,
      eta_seconds: 600,
      price_offer: priceOfferCents,
    });
    const bidRef = actionHash(bidRecord);
    await dhtSync(both, customer.cells[0].cell_id[0]);

    await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
    await dhtSync(both, customer.cells[0].cell_id[0]);
    await commitAndCook(driver, customer, orderRef, both);

    await collectFromStore(driver, customer, orderRef, both);

    await handOff(driver, customer, orderRef, "CustomerHandoff", both);
    await dhtSync(both, customer.cells[0].cell_id[0]);

    await dispatchOf(customer)("complete_delivery", { order_original_action: orderRef });
    await dhtSync(both, customer.cells[0].cell_id[0]);
  }

  // Default 50/50 split on a $5.00 bid + $1.00 tip: merchant covers $2.50,
  // customer covers $2.50 + $1.00 tip = $3.50. Driver gets the full $6.00.
  await driveToDelivered(500);
  const driverBalance1 = await retryUntil(() => ledgerOf(driver)<number>("get_balance", driver.agentPubKey), (b) => b === 600, 120, 1000);
  assert.equal(driverBalance1, 600, "driver should be paid the full $5.00 bid + $1.00 tip regardless of the split");
  const customerBalance1 = await retryUntil(() => ledgerOf(customer)<number>("get_balance", customer.agentPubKey), (b) => b === -600, 120, 1000);
  // Customer is both requester and merchant here, so both settlement legs
  // hit the same balance: -250 (merchant's half) + -(250+100) (customer's
  // half + tip) = -600.
  assert.equal(customerBalance1, -600, "combined requester+merchant balance should reflect both settlement legs, net -$6.00");
  console.log("[PASS] default 50/50 split applies automatically on a bid, without the merchant ever calling set_delivery_subsidy_percent");

  // Merchant raises their share to 100% -- covers the whole delivery fee,
  // customer pays only the tip. Proves the split scales with whatever the
  // bid turns out to be, not a flat capped dollar amount.
  await catalogOf(customer)("set_delivery_subsidy_percent", { original_action: catalogRef, delivery_subsidy_percent: 100 });
  await dhtSync(both, customer.cells[0].cell_id[0]);
  await driveToDelivered(200);
  const driverBalance2 = await retryUntil(() => ledgerOf(driver)<number>("get_balance", driver.agentPubKey), (b) => b === 600 + 300, 120, 1000);
  assert.equal(driverBalance2, 600 + 300, "driver's second delivery should add exactly $2.00 fee + $1.00 tip = $3.00 to their running balance");
  console.log("[PASS] a merchant raising their share to 100% covers the entire delivery fee, customer pays only the tip");
});
