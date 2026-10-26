// Proves the premise behind the driver dashboard's multi-delivery support
// (architecture plan §7's "offer an active driver a 3rd delivery on their
// route" gap): nothing in the backend actually restricts a single driver
// to one accepted order at a time -- confirmed here empirically, against a
// real conductor, rather than just read off validate_new_bid/accept_bid's
// source. The client-side MAX_CONCURRENT_DELIVERIES cap is a deliberate UX
// choice, not something the protocol itself enforces or needs.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, bytesEqual, decodeEntry, retryUntil, ST_PETE, testApp, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customerA, customerB, driver] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
    testApp,
  ]);
  const all = [customerA, customerB, driver];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof driver) => retryingCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof driver) => retryingCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof driver) => retryingCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(customerA)("create_profile", { display_name: "Cara A", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(customerB)("create_profile", { display_name: "Cara B", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

  async function placeOrderFor(customer: typeof customerA) {
    const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Kitchen", location: ST_PETE });
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
    return actionHash(orderRecord);
  }

  const orderRefA = await placeOrderFor(customerA);
  const orderRefB = await placeOrderFor(customerB);
  await dhtSync(all, driver.cells[0].cell_id[0]);
  await acceptOrder(customerA, orderRefA, all);
  await acceptOrder(customerB, orderRefB, all);

  // The same driver bids on, and wins, both orders -- from two entirely
  // separate requester/merchant identities, so this isn't the self-dealing
  // case (self-dealing-bid.test.ts covers that separately).
  const bidRecordA = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRefA,
    eta_seconds: 600,
    price_offer: 400,
  });
  const bidRecordB = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRefB,
    eta_seconds: 600,
    price_offer: 400,
  });
  await dhtSync(all, driver.cells[0].cell_id[0]);

  await dispatchOf(customerA)("accept_bid", { order_original_action: orderRefA, bid_action: actionHash(bidRecordA) });
  await dispatchOf(customerB)("accept_bid", { order_original_action: orderRefB, bid_action: actionHash(bidRecordB) });
  await dhtSync(all, driver.cells[0].cell_id[0]);

  // Both land in the driver's active-delivery queue, linked by each
  // customer when they accepted.
  const active = await retryUntil(
    () => dispatchOf(driver)<{ order: { original_action: Uint8Array } }[]>("get_my_active_deliveries", null),
    (rows) => rows.length === 2,
  );
  const activeHexes = active.map((row) => Buffer.from(row.order.original_action).toString("hex")).sort();
  assert.deepEqual(activeHexes, [orderRefA, orderRefB].map((ref) => Buffer.from(ref).toString("hex")).sort(), "the driver's active queue should hold exactly orders A and B");

  const orderA = decodeEntry<{ status: string; accepted_bid: Uint8Array }>(await dispatchOf(driver)<HcRecord>("get_order", orderRefA));
  const orderB = decodeEntry<{ status: string; accepted_bid: Uint8Array }>(await dispatchOf(driver)<HcRecord>("get_order", orderRefB));
  // The driver's app commits to each as soon as it hears, and each store's
  // starts cooking -- so either may already have moved on.
  const assigned = ["BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed"];
  assert.ok(assigned.includes(orderA.status) && bytesEqual(orderA.accepted_bid, actionHash(bidRecordA)), "order A is the driver's");
  assert.ok(assigned.includes(orderB.status) && bytesEqual(orderB.accepted_bid, actionHash(bidRecordB)), "order B is the same driver's");
  console.log("[PASS] a single driver can hold two genuinely concurrent accepted deliveries -- nothing in the backend restricts this");
});
