// Proves one agent can own and run several stores, each fully independent:
// list_my_catalogs returns every store in creation order; each store has
// its own menu and its own delivery/pickup order queues; an order must
// name the store's real owner as its merchant (validate(), not just the
// UI); and completion reputation lands on the store the order came from,
// never the owner's other stores.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, bytesEqual, decodeEntry, retryUntilOk, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([{ appBundleSource: appSource }, { appBundleSource: appSource }]);
  const all = [customer, merchant];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");
  const reputationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "reputation");
  type CatalogView = { original_action: Uint8Array; record: HcRecord };

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });

  assert.deepEqual(await catalogOf(merchant)<CatalogView[]>("list_my_catalogs", null), [], "a new merchant starts with no stores");

  const storeA = actionHash(await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE }));
  const storeB = actionHash(await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Tacos", location: ST_PETE }));
  console.log("[PASS] publish_catalog allows an owner to open a second store");

  // Editing store A must not reorder the list or drift its identity.
  await catalogOf(merchant)("set_catalog_open", { original_action: storeA, is_open: false });
  const mine = await catalogOf(merchant)<CatalogView[]>("list_my_catalogs", null);
  assert.equal(mine.length, 2);
  assert.ok(bytesEqual(mine[0].original_action, storeA) && bytesEqual(mine[1].original_action, storeB), "stores come back in creation order, keyed by original_action");
  assert.equal(decodeEntry<{ business_name: string; is_open: boolean }>(mine[0].record).is_open, false, "each entry's record reflects that store's latest state");
  assert.equal(decodeEntry<{ business_name: string }>(mine[1].record).business_name, "Mo's Tacos");
  console.log("[PASS] list_my_catalogs returns every store, oldest first, with stable ids and latest content");
  await catalogOf(merchant)("set_catalog_open", { original_action: storeA, is_open: true });

  const itemA = actionHash(await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: storeA, name: "Cuban Sandwich", price_cents: 1250, available: true }));
  const itemB = actionHash(await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: storeB, name: "Al Pastor", price_cents: 900, available: true }));
  const menuA = await catalogOf(merchant)<{ items: { original_action: Uint8Array; record: HcRecord }[] }>("list_menu_items", { catalog_ref: storeA, after: null });
  assert.equal(menuA.items.length, 1);
  assert.ok(bytesEqual(menuA.items[0].original_action, itemA), "store A's menu must only contain store A's items");
  console.log("[PASS] each store keeps its own menu");
  await sync();

  // --- An order must name the store's real owner as its merchant. ---
  await assert.rejects(
    dispatchOf(customer)("request_pickup_order", { merchant: customer.agentPubKey, catalog_ref: storeA, items: [{ item_ref: itemA, quantity: 1 }], order_total: 1250 }),
    /owner of catalog_ref/,
    "a pickup order naming someone other than the store's owner must be rejected",
  );
  await assert.rejects(
    dispatchOf(customer)("request_delivery", {
      merchant: customer.agentPubKey,
      catalog_ref: storeA,
      items: [{ item_ref: itemA, quantity: 1 }],
      order_total: 1250,
      dropoff: ST_PETE,
      max_delivery_fee: null,
    }),
    /owner of catalog_ref/,
    "a delivery order naming someone other than the store's owner must be rejected",
  );
  console.log("[PASS] validate() rejects an order whose merchant doesn't own its store");

  // --- Each store has its own order queues. ---
  const deliveryA = actionHash(
    await dispatchOf(customer)<HcRecord>("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: storeA,
      items: [{ item_ref: itemA, quantity: 1 }],
      order_total: 1250,
      dropoff: ST_PETE,
      max_delivery_fee: null,
    }),
  );
  const pickupB = actionHash(
    await dispatchOf(customer)<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: storeB, items: [{ item_ref: itemB, quantity: 1 }], order_total: 900 }),
  );
  await sync();

  type StoreOrder = { kind: "Delivery" | "Pickup"; original_action: Uint8Array; record: HcRecord };
  const activeA = await retryUntilOk(async () => {
    const rows = await dispatchOf(merchant)<StoreOrder[]>("get_active_orders_for_store", storeA);
    assert.equal(rows.length, 1);
    return rows;
  });
  assert.equal(activeA[0].kind, "Delivery");
  assert.ok(bytesEqual(activeA[0].original_action, deliveryA));
  assert.equal(decodeEntry<{ order_total: number }>(activeA[0].record).order_total, 1250);
  const activeB = await retryUntilOk(async () => {
    const rows = await dispatchOf(merchant)<StoreOrder[]>("get_active_orders_for_store", storeB);
    assert.equal(rows.length, 1);
    return rows;
  });
  assert.equal(activeB[0].kind, "Pickup");
  assert.equal(decodeEntry<{ order_total: number }>(activeB[0].record).order_total, 900);
  console.log("[PASS] each store's active queue holds only that store's orders");

  // --- Reputation lands on the store the order came from. ---
  await dispatchOf(merchant)("confirm_pickup_prep", pickupB);
  await dispatchOf(merchant)("mark_ready_for_pickup", pickupB);
  await sync();
  await dispatchOf(customer)("complete_pickup", pickupB);
  await sync();
  type Rep = { completed_count: number };
  await retryUntilOk(async () => {
    assert.equal((await reputationOf(merchant)<Rep>("get_reputation_summary", { Store: storeB })).completed_count, 1);
  });
  assert.equal((await reputationOf(merchant)<Rep>("get_reputation_summary", { Store: storeA })).completed_count, 0, "store A must not be credited with store B's pickup");
  console.log("[PASS] a completed pickup counts toward its own store only");

  // The delivery order is untouched by all of the above.
  assert.equal(decodeEntry<{ status: string }>(await dispatchOf(customer)<HcRecord>("get_order", deliveryA)).status, "Placed");
});
