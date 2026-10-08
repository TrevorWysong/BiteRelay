// Proves the customer's and driver's order queues (see
// `dispatch_integrity::order_queues`): a customer's in-progress orders and
// paginated history, and a driver's in-progress deliveries -- including a
// scheduled order, which drivers bid on through the update that opened it
// rather than its original action.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, retryUntil, ST_PETE } from "./helpers.js";

interface OrderEntry {
  kind: "Delivery" | "Pickup";
  original_action: Uint8Array;
  record: HcRecord;
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const hexes = (entries: { original_action: Uint8Array }[]) => entries.map((e) => hex(e.original_action)).sort();

await runScenario(async (scenario) => {
  const [merchant, customer, driver] = await scenario.addPlayersWithApps([{ appBundleSource: appSource }, { appBundleSource: appSource }, { appBundleSource: appSource }]);
  const all = [merchant, customer, driver];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(all, merchant.cells[0].cell_id[0]);
  const call = (p: typeof merchant, zome: string) => getZomeCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(merchant, "profiles")("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await call(customer, "profiles")("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dee Driver", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Burger", price_cents: 1000, available: true }));
  await sync();

  const delivery = async (fields: Record<string, unknown> = {}) =>
    actionHash(
      await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, item_refs: [item], order_total: 1000, dropoff: ST_PETE, max_delivery_fee: null, ...fields }),
    );
  const pickup = async () => actionHash(await call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, item_refs: [item], order_total: 1000 }));
  const myActive = () => call(customer, "dispatch")<OrderEntry[]>("get_my_active_orders", null);
  const myHistory = (before: number | null, limit: number | null) =>
    call(customer, "dispatch")<{ orders: OrderEntry[]; next_before: number | null }>("get_my_order_history", { before, limit });

  // --- A customer's in-progress orders, both kinds. ---
  const cancelled = await delivery();
  const live = await delivery();
  const pickupOrder = await pickup();
  assert.deepEqual(hexes(await myActive()), [cancelled, live, pickupOrder].map(hex).sort(), "every placed order starts in progress");
  await call(customer, "dispatch")("set_order_status", { order_original_action: cancelled, next_status: "Cancelled" });
  assert.deepEqual(hexes(await myActive()), [live, pickupOrder].map(hex).sort(), "a cancelled order leaves the in-progress list");
  console.log("[PASS] a customer's in-progress list holds exactly their unfinished orders, delivery and pickup");

  // --- History keeps everything, a page at a time, newest first. ---
  const first = await myHistory(null, 2);
  assert.equal(first.orders.length, 2, "a page holds at most `limit` orders");
  assert.ok(first.next_before !== null, "more history means a cursor to it");
  const second = await myHistory(first.next_before, 2);
  assert.equal(second.orders.length, 1);
  assert.equal(second.next_before, null, "the last page has no cursor");
  const paged = [...first.orders, ...second.orders];
  assert.deepEqual(hexes(paged), [cancelled, live, pickupOrder].map(hex).sort(), "history pages cover every order exactly once");
  const placedAt = paged.map((entry) => decodeEntry<{ requested_at: number }>(entry.record).requested_at);
  assert.deepEqual(placedAt, [...placedAt].sort((a, b) => b - a), "history comes newest first");
  console.log("[PASS] a customer's history keeps every order, paginated newest first");

  // --- A scheduled order: drivers bid on the update that opened it. ---
  const scheduled = await delivery({ requested_delivery_time: now - 1_000_000 });
  const opened = actionHash(await call(customer, "dispatch")<HcRecord>("open_scheduled_order", scheduled));
  await sync();
  const bid = actionHash(
    await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: opened, eta_seconds: 600, price_offer: 500, collateral_commitment: { account: "stub", amount: 0, ledger_txn_ref: "pending" } }),
  );
  await sync();
  const bids = await retryUntil(
    () => call(customer, "dispatch")<{ bids: HcRecord[] }>("list_bids_for_order", { order_ref: scheduled, after: null }),
    (page) => page.bids.length === 1,
  );
  assert.equal(bids.bids.length, 1, "a bid on the opened version is found under the order's identity");
  await call(customer, "dispatch")("accept_bid", { order_original_action: scheduled, bid_action: bid });
  await sync();
  const deliveries = await retryUntil(
    () => call(driver, "dispatch")<{ order: OrderEntry }[]>("get_my_active_deliveries", null),
    (rows) => rows.length === 1,
  );
  assert.deepEqual(
    deliveries.map((d) => hex(d.order.original_action)),
    [hex(scheduled)],
    "the accepted scheduled order is in the driver's active deliveries",
  );
  console.log("[PASS] bids on a scheduled order reach the customer, and accepting one assigns the driver");

  // --- Finishing a delivery clears it from the driver's queue too. ---
  await call(customer, "dispatch")("set_order_status", { order_original_action: scheduled, next_status: "Cancelled" });
  await sync();
  const after = await retryUntil(
    () => call(driver, "dispatch")<unknown[]>("get_my_active_deliveries", null),
    (rows) => rows.length === 0,
  );
  assert.equal(after.length, 0, "a cancelled delivery leaves the driver's queue");
  console.log("[PASS] a delivery that ends leaves the driver's active queue");
});
