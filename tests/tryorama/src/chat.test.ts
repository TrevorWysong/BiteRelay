// Proves direct chat between an order's two active parties (architecture
// plan's §7/§3 "direct signal traffic, never a DHT commit" pattern applied
// to messaging): both directions actually deliver, and an unrelated third
// party can't send on an order they're not a party to.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, waitForSignal, ST_PETE, acceptOrder } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, driver, stranger] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const all = [customer, driver, stranger];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });
  await profilesOf(stranger)("create_profile", { display_name: "Sam Stranger", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 600, available: true });
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
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await acceptOrder(customer, orderRef, all);

  // Before any bid is accepted, chat has no "other party" to resolve yet.
  await assert.rejects(
    dispatchOf(driver)("send_chat_message", { order_ref: orderRef, text: "hello?" }),
    /chat is only available once a driver has been assigned/,
    "chat must be rejected before a bid is accepted",
  );
  console.log("[PASS] chat rejected before any driver is assigned");

  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRef,
    eta_seconds: 600,
    price_offer: 400,
    collateral_commitment: { account: "stub", amount: 0, ledger_txn_ref: "pending" },
  });
  const bidRef = actionHash(bidRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const toCustomer = waitForSignal(customer.appWs, (p) => "ChatMessage" in p, 5000);
  await dispatchOf(driver)("send_chat_message", { order_ref: orderRef, text: "On my way!" });
  const receivedByCustomer = await toCustomer;
  assert.ok(receivedByCustomer, "customer should receive the driver's chat message");
  assert.equal(receivedByCustomer.ChatMessage.text, "On my way!");
  console.log("[PASS] driver -> customer chat message delivered");

  const toDriver = waitForSignal(driver.appWs, (p) => "ChatMessage" in p, 5000);
  await dispatchOf(customer)("send_chat_message", { order_ref: orderRef, text: "Great, thank you!" });
  const receivedByDriver = await toDriver;
  assert.ok(receivedByDriver, "driver should receive the customer's reply");
  assert.equal(receivedByDriver.ChatMessage.text, "Great, thank you!");
  console.log("[PASS] customer -> driver chat message delivered");

  await assert.rejects(
    dispatchOf(stranger)("send_chat_message", { order_ref: orderRef, text: "can I butt in?" }),
    /only this order's requester or its accepted driver can send chat messages/,
    "an unrelated agent must not be able to send chat messages on this order",
  );
  console.log("[PASS] an unrelated third party cannot send chat messages on this order");
});
