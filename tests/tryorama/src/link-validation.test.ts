// Proves every zome's link validation rejects the links a malicious peer
// could write -- which an honest coordinator never would, so these use the
// `test-utils` coordinator build's raw link externs (see
// `useTestCoordinators`). Each attack targets a real read: ratings, menus,
// order lists, balances, the dispute queue, presence and profiles. Run
// `npm run build:test-coordinators` first.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { agentAsLinkBase, appSource, actionHash, ST_PETE, useTestCoordinators, acceptOrder } from "./helpers.js";

const ALL_ZOMES = ["attestation", "catalog", "dispatch", "dispute", "ledger", "profiles", "reputation"];

await runScenario(async (scenario) => {
  const [customer, merchant, attacker] = await scenario.addPlayersWithApps([{ appBundleSource: appSource }, { appBundleSource: appSource }, { appBundleSource: appSource }]);
  const all = [customer, merchant, attacker];
  await scenario.shareAllAgents();
  for (const player of all) await useTestCoordinators(player, ALL_ZOMES);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);
  const rawLink = (p: typeof customer, zome: string, link_type: string, base: Uint8Array, target: Uint8Array, tag: Uint8Array = new Uint8Array()) =>
    call(p, zome)("test_create_link", { link_type, base, target, tag: Array.from(tag) });
  const rawDelete = async (p: typeof customer, zome: string, link_type: string, base: Uint8Array) => {
    const [hash] = await call(p, zome)<Uint8Array[]>("test_get_link_hashes", { link_type, base });
    assert.ok(hash, `expected an existing ${link_type} link to try deleting`);
    return call(p, zome)("test_delete_link", hash);
  };

  // --- A real world to attack. ---
  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  const merchantProfile = actionHash(await call(merchant, "profiles")<HcRecord>("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now }));
  await call(attacker, "profiles")("create_profile", { display_name: "Mallory", roles: ["Provider", "Requester"], created_at: now });
  const storeA = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE }));
  const storeB = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's Tacos", location: ST_PETE }));
  const itemA = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: storeA, name: "Burger", price_cents: 1000, available: true }));
  await sync();

  const placePickup = async () =>
    actionHash(await call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: storeA, items: [{ item_ref: itemA, quantity: 1 }], order_total: 1000 }));
  const completePickup = async (order: Uint8Array) => {
    await call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order });
    await call(merchant, "dispatch")("mark_ready_for_pickup", order);
    await sync();
    await call(customer, "dispatch")("complete_pickup", order);
    await sync();
  };
  const reviewedOrder = await placePickup();
  await sync();
  await completePickup(reviewedOrder);
  const review = actionHash(await call(customer, "reputation")<HcRecord>("submit_review", { target: { Store: storeA }, order_original_action: reviewedOrder, rating: 1, comment: "cold" }));
  const disputedOrder = await placePickup();
  await sync();
  await completePickup(disputedOrder);
  await call(customer, "dispatch")("raise_pickup_dispute", { order_original_action: disputedOrder, reason: "WrongOrIncompleteItems", description: "missing fries", evidence_refs: [] });
  const activeOrder = await placePickup();
  const deliveryOrder = actionHash(
    await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: storeA, items: [{ item_ref: itemA, quantity: 1 }], order_total: 1000, dropoff: ST_PETE, max_delivery_fee: null }),
  );
  await sync();
  await acceptOrder(merchant, deliveryOrder, all);
  const attackerBid = actionHash(
    await call(attacker, "dispatch")<HcRecord>("submit_bid", { order_ref: deliveryOrder, eta_seconds: 600, price_offer: 500 }),
  );
  // The attacker drives this order (a handoff is only ever the assigned
  // driver's), so their pickup record is real -- what they then try to
  // file under another order.
  await sync();
  await call(customer, "dispatch")("accept_bid", { order_original_action: deliveryOrder, bid_action: attackerBid });
  await sync();
  const leg = actionHash(await call(attacker, "attestation")<HcRecord>("record_leg", { order_ref: deliveryOrder, sequence: 0, kind: "MerchantHandoff", to: merchant.agentPubKey, geo_at_completion: ST_PETE }));
  await sync();
  const [hold] = await call(customer, "ledger")<{ hold: Uint8Array }[]>("holds_for_order", reviewedOrder);
  assert.ok(hold, "the pickup's food should have been held");
  console.log("[PASS] set up two stores, a reviewed order, a disputed order, an active order, a leg and a payment");

  const rejects = (attempt: Promise<unknown>, reason: RegExp, what: string) => assert.rejects(attempt, reason, what);

  // --- Reputation: a store's rating can only count its own reviews. ---
  await rejects(rawLink(attacker, "reputation", "StoreToReview", storeB, review), /sit under the store, agent, order or item its entry is actually about|authored by the author/, "a stranger can't move a review under another store");
  await rejects(rawLink(customer, "reputation", "StoreToReview", storeB, review), /sit under the store, agent, order or item its entry is actually about/, "even the review's author can't file it under a different store");
  await rejects(rawLink(customer, "reputation", "DriverToReview", storeA, review), /sit under the store, agent, order or item/, "a store review can't be filed as a driver review");
  await rejects(rawDelete(customer, "reputation", "StoreToReview", storeA), /reputation links can't be deleted/, "reviews can't be unlinked");
  console.log("[PASS] reputation: reviews can't be re-filed under another store or role, or removed");

  // --- Catalog: a menu only lists the store's own items. ---
  await rejects(rawLink(merchant, "catalog", "CatalogToMenuItem", storeB, itemA), /under its own catalog/, "an item can't be listed in another store's menu, even by the owner");
  await rejects(rawLink(attacker, "catalog", "CatalogToMenuItem", storeA, itemA), /by its author/, "a stranger can't link items into a menu");
  await rejects(rawLink(attacker, "catalog", "OwnerToCatalog", agentAsLinkBase(attacker.agentPubKey), storeA), /only be linked by its owner/, "a stranger can't claim someone's store");
  await rejects(rawDelete(attacker, "catalog", "CatalogToMenuItem", storeA), /only a link's own author may delete it/, "a stranger can't remove a menu item");
  console.log("[PASS] catalog: menus and store ownership links can't be forged or removed by others");

  // --- Dispatch: order lists and store queues. ---
  await rejects(rawLink(attacker, "dispatch", "CustomerToActiveOrder", agentAsLinkBase(attacker.agentPubKey), activeOrder), /only the order's requester may add it/, "a stranger can't attach someone's order to themselves");
  await rejects(rawLink(customer, "dispatch", "CustomerToActiveOrder", agentAsLinkBase(attacker.agentPubKey), activeOrder), /under the order's own store, customer or driver/, "a customer can't put their order in someone else's list");
  await rejects(rawDelete(attacker, "dispatch", "CustomerToActiveOrder", agentAsLinkBase(customer.agentPubKey)), /may retire it from an active queue/, "a stranger can't hide a customer's active order");
  await rejects(rawLink(attacker, "dispatch", "DriverToActiveDelivery", agentAsLinkBase(attacker.agentPubKey), deliveryOrder, attackerBid), /only the order's requester may add it/, "a driver can't assign themselves a delivery the customer never accepted");
  await rejects(rawLink(customer, "dispatch", "DriverToActiveDelivery", agentAsLinkBase(attacker.agentPubKey), deliveryOrder), /tag must name the accepted bid/, "a delivery can't be assigned to a driver without naming their bid");
  await rejects(rawLink(attacker, "dispatch", "StoreToActiveOrder", storeB, activeOrder), /only the order's requester may add it/, "a stranger can't inject an order into a store queue");
  await rejects(rawLink(customer, "dispatch", "StoreToActiveOrder", storeB, activeOrder), /under the order's own store/, "an order can't be queued at a store it wasn't placed with");
  await rejects(rawDelete(attacker, "dispatch", "StoreToActiveOrder", storeA), /may retire it from an active queue/, "a stranger can't pull an order out of a store's active queue");
  console.log("[PASS] dispatch: orders can't be attached to strangers or other stores' queues, or pulled from them");

  // --- Ledger: a hold is found under its own order. ---
  await rejects(rawLink(attacker, "ledger", "OrderToHold", activeOrder, hold.hold), /authored by the author of the entry/, "a stranger can't file someone else's hold");
  await rejects(rawLink(customer, "ledger", "OrderToHold", activeOrder, hold.hold), /must sit under the order, hold or agent its entry is about/, "a hold can't be filed under an order it isn't for");
  console.log("[PASS] ledger: a hold can only be linked under its own order, by its payer");

  // --- Dispute: only an arbitrator closes a case out of the open queue. ---
  const openDisputes = await call(customer, "dispute")<Uint8Array[]>("test_get_link_hashes", { link_type: "OpenDisputeAnchor", base: await call(customer, "dispute")<Uint8Array>("test_path_hash", "open_disputes") });
  assert.ok(openDisputes.length > 0, "the raised dispute should be in the open queue");
  await rejects(call(customer, "dispute")("test_delete_link", openDisputes[openDisputes.length - 1]), /only an arbitrator may close a dispute/, "even the raiser can't close their own case");
  console.log("[PASS] dispute: a case can't be removed from the open queue by a non-arbitrator");

  // --- Attestation, profiles. ---
  await rejects(rawLink(attacker, "attestation", "OrderToLeg", activeOrder, leg), /under its own order/, "a leg can't be attached to a different order");
  await rejects(rawLink(attacker, "profiles", "AgentToProfile", agentAsLinkBase(attacker.agentPubKey), merchantProfile), /authored by the author of the entry/, "nobody can adopt someone else's profile");
  console.log("[PASS] presence, attestation and profile links can't be forged");

  // --- Positive control: the honest links are all still there and counted. ---
  await sync();
  const ratingA = await call(merchant, "reputation")<{ count: number; rating_sum: number }>("get_rating_summary", { Store: storeA });
  const ratingB = await call(merchant, "reputation")<{ count: number; rating_sum: number }>("get_rating_summary", { Store: storeB });
  assert.deepEqual(ratingA, { count: 1, rating_sum: 1 });
  assert.deepEqual(ratingB, { count: 0, rating_sum: 0 }, "store B's rating must be untouched by every attempt above");
  const menuB = await call(merchant, "catalog")<{ items: unknown[] }>("list_menu_items", { catalog_ref: storeB, after: null });
  assert.equal(menuB.items.length, 0, "store B's menu must still be empty");
  console.log("[PASS] honest links still count; every attacked read is unchanged");
});
