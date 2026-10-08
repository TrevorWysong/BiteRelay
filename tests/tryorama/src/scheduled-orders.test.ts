// Proves scheduled/future delivery orders: a Scheduled order is invisible
// to matching until opened, opening too early is rejected, and opening
// once the requested time has passed succeeds and makes it discoverable --
// exactly like a normal order from that point on.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, driver] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const both = [customer, driver];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 600, available: true });
  const menuItemRef = actionHash(menuItemRecord);

  const farFuture = now + 60 * 60 * 1_000_000; // 1 hour out, in microseconds
  const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: customer.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 600,
    dropoff: ST_PETE,
    max_delivery_fee: null,
    requested_delivery_time: farFuture,
  });
  const orderRef = actionHash(orderRecord);
  const decoded = decodeEntry<{ status: string; dropoff_geohash: string }>(orderRecord);
  assert.equal(decoded.status, "Scheduled", "an order with requested_delivery_time should start in Scheduled, not Open");
  console.log("[PASS] request_delivery with a future requested_delivery_time creates a Scheduled order");

  await dhtSync(both, customer.cells[0].cell_id[0]);
  const geohash = decoded.dropoff_geohash;
  const nearbyWhileScheduled = await dispatchOf(driver)<HcRecord[]>("get_open_orders_near", geohash);
  assert.equal(nearbyWhileScheduled.length, 0, "a Scheduled order must not be discoverable via get_open_orders_near");
  console.log("[PASS] a Scheduled order is invisible to matching until opened");

  await assert.rejects(
    dispatchOf(customer)("open_scheduled_order", orderRef),
    /requested_delivery_time has not arrived yet/,
    "opening a scheduled order before its time must be rejected",
  );
  console.log("[PASS] open_scheduled_order rejects opening before the requested time");

  // A second order, scheduled for a moment already in the past -- opening
  // it should succeed immediately.
  const justPast = now - 1_000_000; // 1 second ago
  const pastOrderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: customer.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 600,
    dropoff: ST_PETE,
    max_delivery_fee: null,
    requested_delivery_time: justPast,
  });
  const pastOrderRef = actionHash(pastOrderRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);

  const openedRecord = await dispatchOf(customer)<HcRecord>("open_scheduled_order", pastOrderRef);
  const openedOrder = decodeEntry<{ status: string }>(openedRecord);
  assert.equal(openedOrder.status, "Open", "opening a due scheduled order should flip it to Open");
  await dhtSync(both, customer.cells[0].cell_id[0]);

  const nearbyAfterOpen = await dispatchOf(driver)<HcRecord[]>("get_open_orders_near", geohash);
  assert.equal(nearbyAfterOpen.length, 1, "the now-Open order should be discoverable via get_open_orders_near");
  console.log("[PASS] opening a due scheduled order succeeds and makes it discoverable, just like a normal order");
});
