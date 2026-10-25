// Proves how many orders a driver may carry, as the big delivery apps limit
// it -- here with a network limit of one, so each rule shows in a few steps:
//
// - a driver at their limit can't take on another order: their app won't
//   bid, a customer's won't accept them, and validation refuses their
//   commitment (the ledger counts the orders in hand, entry to entry, like a
//   balance);
// - a priority order goes to a driver with nothing else, and alone;
// - a driver can't hide what they've taken on from customers;
// - an order that never arrives frees its driver once they forfeit its
//   collateral -- which their app does on the store's decision.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, agentAsLinkBase, collectFromStore, commitAndCook, handOff, latestLedgerEntry, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators, retryingCaller } from "./helpers.js";

const FOOD = 1000;

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await setupPlayersWithProperties(scenario, 3, () => ({ max_concurrent_deliveries: 1 }));
  const all = [customer, merchant, driver];
  for (const p of all) await useTestCoordinators(p, ["dispatch", "ledger"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const load = () => call(customer, "dispatch")<{ orders: number; priority: boolean }>("get_driver_load", driver.agentPubKey);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: FOOD, available: true }));
  await sync();

  /// A delivery the store has accepted, open for bids.
  async function openOrder(priority = false) {
    const ref = actionHash(
      await retryUntilOk(() =>
        call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: FOOD, dropoff: ST_PETE, max_delivery_fee: null, priority }),
      ),
    );
    await sync();
    await acceptOrder(merchant, ref, all);
    return ref;
  }
  const bidOn = async (ref: Uint8Array) => actionHash(await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: ref, eta_seconds: 600, price_offer: 400 }));
  const accept = (ref: Uint8Array, bid: Uint8Array) => call(customer, "dispatch")("accept_bid", { order_original_action: ref, bid_action: bid });

  // Two orders, bid on while the driver had nothing on.
  const first = await openOrder();
  const second = await openOrder();
  const firstBid = await bidOn(first);
  const secondBid = await bidOn(second);
  await sync();
  await retryUntilOk(() => accept(first, firstBid));
  await sync();
  assert.deepEqual(await retryUntil(load, (l) => l.orders === 1), { orders: 1, priority: false }, "customers see what the driver has taken on");
  await assert.rejects(accept(second, secondBid), /as many orders as they can carry/, "a customer can't give a driver more than they may carry");
  const third = await openOrder();
  await assert.rejects(bidOn(third), /the most at once/, "nor does the driver's app bid past it");
  console.log("[PASS] a driver at their limit isn't given another order");

  // The driver can't hide their load.
  const [link] = await call(driver, "dispatch")<Uint8Array[]>("test_get_link_hashes", { link_type: "DriverToActiveDelivery", base: agentAsLinkBase(driver.agentPubKey) });
  await assert.rejects(call(driver, "dispatch")("test_delete_link", link), /only the order's requester or merchant/, "a driver can't take an order off their own queue");
  console.log("[PASS] a driver can't hide what they've taken on");

  // Out for delivery: one in hand.
  await commitAndCook(driver, merchant, first, all);
  await collectFromStore(driver, merchant, first, all);
  await sync();
  const inHand = await latestLedgerEntry(driver);
  assert.deepEqual(inHand.in_hand, { orders: 1, priority: false }, "the driver's ledger counts the order in hand");

  // A modified app committing to a second anyway: validation refuses it.
  const forged = call(driver, "ledger")("create_raw_ledger_entry_for_testing", {
    kind: { Hold: { order: second, purpose: { Collateral: { bid: secondBid } } } },
    amount: FOOD,
    balance: inHand.balance - FOOD,
    in_hand: { orders: 2, priority: false },
    previous: inHand.hash,
  });
  await assert.rejects(forged, /no more orders at once than the network allows/, "the network refuses a commitment past the limit");
  console.log("[PASS] validation counts the orders in hand and refuses a commitment past the limit");

  // ===== Priority =====
  const priority = await openOrder(true);
  await assert.rejects(bidOn(priority), /goes to a driver with no other orders/, "a priority order isn't bid on by a driver with others");
  console.log("[PASS] a priority order goes only to a driver with nothing else");

  // ===== It never arrives: the driver forfeits, and is free again =====
  await call(customer, "dispatch")("claim_never_arrived", first);
  await sync();
  await retryUntilOk(() => call(merchant, "dispatch")<Uint8Array>("decide_not_delivered", first));
  await sync();
  const freed = await retryUntil(
    async () => {
      await call(driver, "dispatch")("settle_order", first).catch(() => 0);
      return (await latestLedgerEntry(driver)).in_hand;
    },
    (hands) => hands.orders === 0,
    60,
    1000,
  );
  assert.deepEqual(freed, { orders: 0, priority: false }, "forfeiting the collateral settles the order in hand");
  await retryUntil(load, (l) => l.orders === 0);
  const priorityBid = await retryUntilOk(() => bidOn(priority));
  assert.ok(priorityBid, "with nothing else on, the driver can take the priority order");
  console.log("[PASS] an order that never arrives frees its driver once they forfeit its collateral");
});
