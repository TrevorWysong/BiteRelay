// Proves a store's two order queues (dispatch_integrity::store_queue):
// the active queue holds exactly the in-progress orders, oldest first, and
// an order leaves it the moment it ends -- whether the merchant cancels it
// or the customer completes it (both must pass delete-link validation);
// history keeps every order, newest first, and pages through them with a
// cursor that ends cleanly on the last page.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, bytesEqual, decodeEntry, retryUntilOk, ST_PETE } from "./helpers.js";

type StoreOrder = { kind: "Delivery" | "Pickup"; original_action: Uint8Array; record: HcRecord };
type HistoryPage = { orders: StoreOrder[]; next_before: number | null };

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([{ appBundleSource: appSource }, { appBundleSource: appSource }]);
  const all = [customer, merchant];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Burger", price_cents: 1000, available: true }));
  await sync();

  // Five orders, alternating kinds, each for a different quantity (so a
  // distinct total) so they're identifiable in any read.
  const placed: { kind: "Delivery" | "Pickup"; ref: Uint8Array; total: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const quantity = i + 1;
    const total = 1000 * quantity;
    const kind = i % 2 === 0 ? "Delivery" : "Pickup";
    const record =
      kind === "Delivery"
        ? await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity }], order_total: total, dropoff: ST_PETE, max_delivery_fee: null })
        : await call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity }], order_total: total });
    placed.push({ kind, ref: actionHash(record), total });
  }
  await sync();

  const totals = (orders: StoreOrder[]) => orders.map((o) => decodeEntry<{ order_total: number }>(o.record).order_total);
  const active = await retryUntilOk(async () => {
    const rows = await call(merchant, "dispatch")<StoreOrder[]>("get_active_orders_for_store", store);
    assert.equal(rows.length, 5);
    return rows;
  });
  assert.deepEqual(totals(active), [1000, 2000, 3000, 4000, 5000], "active queue must be oldest first");
  assert.deepEqual(active.map((o) => o.kind), ["Delivery", "Pickup", "Delivery", "Pickup", "Delivery"]);
  assert.ok(active.every((o, i) => bytesEqual(o.original_action, placed[i].ref)), "entries must carry each order's original action, not its latest");
  console.log("[PASS] the active queue holds every in-progress order, oldest first, with stable ids");

  // The merchant cancels a delivery; the customer completes a pickup.
  await call(merchant, "dispatch")("decline_order", { order_original_action: placed[0].ref, reason: "TooBusy" });
  await call(merchant, "dispatch")("confirm_pickup_prep", placed[1].ref);
  await call(merchant, "dispatch")("mark_ready_for_pickup", placed[1].ref);
  await sync();
  await call(customer, "dispatch")("complete_pickup", placed[1].ref);
  await sync();

  await retryUntilOk(async () => {
    const rows = await call(merchant, "dispatch")<StoreOrder[]>("get_active_orders_for_store", store);
    assert.deepEqual(totals(rows), [3000, 4000, 5000]);
  });
  console.log("[PASS] a cancelled (by the merchant) and a completed (by the customer) order both leave the active queue");

  // History: everything, newest first, two at a time.
  const seen: StoreOrder[] = [];
  let before: number | null = null;
  const pageSizes: number[] = [];
  do {
    const page: HistoryPage = await call(merchant, "dispatch")<HistoryPage>("get_order_history_for_store", { catalog_ref: store, before, limit: 2 });
    pageSizes.push(page.orders.length);
    seen.push(...page.orders);
    before = page.next_before;
  } while (before !== null);
  assert.deepEqual(pageSizes, [2, 2, 1], "five orders in pages of two");
  assert.deepEqual(totals(seen), [5000, 4000, 3000, 2000, 1000], "history must be newest first with no gaps or repeats");
  const statusOf = (total: number) => decodeEntry<{ status: string }>(seen.find((o) => totals([o])[0] === total)!.record).status;
  assert.equal(statusOf(1000), "Cancelled");
  assert.equal(statusOf(2000), "PickedUp");
  console.log("[PASS] history pages through every order newest first, finished ones included, and the cursor ends on the last page");

  const fullPage = await call(merchant, "dispatch")<HistoryPage>("get_order_history_for_store", { catalog_ref: store, before: null, limit: null });
  assert.equal(fullPage.orders.length, 5);
  assert.equal(fullPage.next_before, null);
  console.log("[PASS] the default page size returns everything when it fits");
});
