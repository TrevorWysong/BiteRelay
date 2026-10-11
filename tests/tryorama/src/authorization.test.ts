// Proves the fix from the "closer look" the user asked for: authorization
// on DeliveryOrder updates is now per-transition, not "any of requester,
// merchant, or accepted provider can drive any transition." Before this
// fix, an accepted provider could unilaterally cancel an order or jump
// straight to MerchantConfirmed -- neither of which they should be able to
// do. This test asserts those specific things are now rejected.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, appSource, commitAndCook, deliveryStatus, ST_PETE, testApp } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, driver] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
  ]);
  const both = [customer, driver];

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

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
  await acceptOrder(customer, orderRef, both);

  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRef,
    eta_seconds: 900,
    price_offer: 400,
  });
  const bidRef = actionHash(bidRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);

  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
  await dhtSync(both, customer.cells[0].cell_id[0]);

  // The order is now BidAccepted. Before the fix, the accepted provider
  // (driver) was allowed to author *any* legal transition on this order --
  // including cancelling it, which should never have been theirs to do.
  await assert.rejects(
    dispatchOf(driver)("cancel_order", orderRef),
    "the accepted provider must not be able to cancel the order",
  );
  console.log("[PASS] Accepted provider cannot cancel the order");

  // Nor should the provider be able to drive the customer/merchant-side
  // transition to MerchantConfirmed.
  await assert.rejects(
    dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "MerchantConfirmed" }),
    "the accepted provider must not be able to confirm merchant prep",
  );
  console.log("[PASS] Accepted provider cannot drive the merchant-side MerchantConfirmed transition");

  // Each side still drives its own: the driver commits, the store (the
  // customer runs it here) starts cooking.
  await commitAndCook(driver, customer, orderRef, both);
  assert.equal(await deliveryStatus(customer, orderRef), "MerchantConfirmed", "the driver commits and the store cooks");
  console.log("[PASS] Each party can still drive their own transitions");
});
