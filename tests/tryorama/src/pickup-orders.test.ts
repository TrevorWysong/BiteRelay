// Proves the pickup vertical's full happy-path lifecycle: no bid, no
// driver, no leg attestation -- just the requester and the merchant. See
// `PickupOrder`'s own doc comment (`dispatch_integrity`) for why this is a
// separate entry type from `DeliveryOrder` rather than a flag on it.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([{ appBundleSource: appSource }, { appBundleSource: appSource }]);
  const all = [customer, merchant];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");
  const ledgerOf = (p: typeof customer) => getZomeCaller(p.cells[0], "ledger");
  const reputationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "reputation");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 600, available: true });
  const menuItemRef = actionHash(menuItemRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const orderRecord = await dispatchOf(customer)<HcRecord>("request_pickup_order", {
    merchant: merchant.agentPubKey,
    catalog_ref: catalogRef,
    item_refs: [menuItemRef],
    order_total: 600,
    special_instructions: "No onions please",
  });
  const orderRef = actionHash(orderRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const placedRecord = await dispatchOf(customer)<HcRecord>("get_pickup_order", orderRef);
  const placed = decodeEntry<{ status: string; special_instructions: string }>(placedRecord);
  assert.equal(placed.status, "Placed");
  assert.equal(placed.special_instructions, "No onions please");
  console.log("[PASS] request_pickup_order creates a Placed order, no driver/dropoff fields involved");

  // Discovery: the merchant can find it without already knowing the hash.
  const merchantSide = await dispatchOf(merchant)<{ kind: string }[]>("get_active_orders_for_store", catalogRef);
  assert.equal(merchantSide.length, 1, "the merchant should discover this pickup order in its store's active queue");
  assert.equal(merchantSide[0].kind, "Pickup");
  console.log("[PASS] get_active_orders_for_store discovers the order");

  await dispatchOf(merchant)("confirm_pickup_prep", orderRef);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(merchant)("mark_ready_for_pickup", orderRef);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await dispatchOf(customer)("complete_pickup", orderRef);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const merchantBalance = await ledgerOf(merchant)<number>("get_balance", merchant.agentPubKey);
  assert.equal(merchantBalance, 600, "merchant should be paid order_total -- no delivery-fee split exists for pickup");
  const customerBalance = await ledgerOf(customer)<number>("get_balance", customer.agentPubKey);
  assert.equal(customerBalance, -600, "customer should be debited exactly order_total, nothing else");
  console.log("[PASS] complete_pickup settles order_total with no delivery-fee concept at all");

  // Finished, so it's left the customer's active queue but stays in history.
  const active = await dispatchOf(customer)<unknown[]>("get_my_active_orders", null);
  assert.equal(active.length, 0, "a picked-up order is no longer in progress");
  const history = await dispatchOf(customer)<{ orders: { kind: string }[] }>("get_my_order_history", { before: null, limit: null });
  assert.deepEqual(history.orders.map((o) => o.kind), ["Pickup"], "the customer's history should hold the one pickup order");
  console.log("[PASS] the customer's queues move a finished pickup order from active to history");

  // Reviews/item-reviews must work against a PickedUp PickupOrder, not just
  // a Delivered DeliveryOrder -- reputation_integrity's validate_review/
  // validate_item_review resolve either order type (see
  // resolve_reviewable_order's own doc comment).
  await reputationOf(customer)("submit_review", { target: { Store: catalogRef }, order_original_action: orderRef, rating: 5, comment: "Great food, ready fast" });
  await reputationOf(customer)("submit_item_review", { item_ref: menuItemRef, order_original_action: orderRef, rating: 4, comment: "" });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const merchantReviews = (await reputationOf(merchant)<{ reviews: HcRecord[] }>("get_reviews_for", { target: { Store: catalogRef }, before: null })).reviews;
  assert.equal(merchantReviews.length, 1);
  const itemSummary = await reputationOf(merchant)<{ count: number; rating_sum: number }>("get_item_rating_summary", menuItemRef);
  assert.equal(itemSummary.count, 1);
  assert.equal(itemSummary.rating_sum, 4);
  console.log("[PASS] submit_review/submit_item_review accept a PickedUp PickupOrder's order_ref, not just a Delivered DeliveryOrder's");

  // A second order, cancelled before pickup -- proves the Cancelled path
  // doesn't require a dispute and doesn't settle any payment.
  const order2Record = await dispatchOf(customer)<HcRecord>("request_pickup_order", {
    merchant: merchant.agentPubKey,
    catalog_ref: catalogRef,
    item_refs: [menuItemRef],
    order_total: 600,
  });
  const order2Ref = actionHash(order2Record);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("cancel_pickup_order", order2Ref);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const merchantBalanceAfterCancel = await ledgerOf(merchant)<number>("get_balance", merchant.agentPubKey);
  assert.equal(merchantBalanceAfterCancel, 600, "cancelling before pickup must not settle any payment");
  console.log("[PASS] cancel_pickup_order leaves payment untouched");
});
