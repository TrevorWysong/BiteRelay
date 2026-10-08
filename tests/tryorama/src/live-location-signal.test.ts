// Proves live driver-location sharing (tracking.rs): rejected before a bid
// is accepted, one-directional (only the assigned driver may send, and it
// always reaches the requester, never the reverse), and an unrelated third
// party can't send on an order they're not the assigned driver for either.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, waitForSignal, ST_PETE } from "./helpers.js";

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

  // Before any bid is accepted, there's no assigned driver to resolve.
  await assert.rejects(
    dispatchOf(driver)("send_location_update", { order_ref: orderRef, lat: 27.77, lon: -82.64 }),
    /live location sharing is only available once a driver has been assigned/,
    "live location must be rejected before a bid is accepted",
  );
  console.log("[PASS] live location sharing rejected before any driver is assigned");

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

  const toCustomer = waitForSignal(customer.appWs, (p) => "LocationUpdate" in p, 5000);
  await dispatchOf(driver)("send_location_update", { order_ref: orderRef, lat: 27.7676, lon: -82.6403 });
  const received = await toCustomer;
  assert.ok(received, "the customer should receive the driver's location update");
  assert.equal(received.LocationUpdate.lat, 27.7676);
  assert.equal(received.LocationUpdate.lon, -82.6403);
  console.log("[PASS] driver -> customer live location update delivered");

  // One-directional, unlike chat -- the customer (now a real party to the
  // order, with an accepted bid resolvable) still isn't the *driver*, so
  // they can't share a location either.
  await assert.rejects(
    dispatchOf(customer)("send_location_update", { order_ref: orderRef, lat: 0, lon: 0 }),
    /only this order's assigned driver can share a live location/,
    "the customer must not be able to send a location update, even though they're a real party to the order",
  );
  console.log("[PASS] the requester (a real party, but not the driver) cannot send a location update");

  await assert.rejects(
    dispatchOf(stranger)("send_location_update", { order_ref: orderRef, lat: 0, lon: 0 }),
    /only this order's assigned driver can share a live location/,
    "an unrelated agent must not be able to send a location update",
  );
  console.log("[PASS] an unrelated third party cannot send a location update");
});
