// Proves a driver's collateral is real: a bid commits the value of the
// order's food, the driver posts it to the customer at pickup (validation
// won't accept a pickup without it), it comes back when the delivery is
// settled, and a ruling for the customer leaves it with them -- which is
// then all the driver can lose.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, decodeEntry, retryUntil, setupArbitratedPlayers, ST_PETE, useTestCoordinators } from "./helpers.js";

const FOOD = 600;
const FEE = 400;

await runScenario(async (scenario) => {
  // The customer runs the store too, so the only money moving is between
  // them and the driver.
  const { customer, driver, arbitrator, all } = await setupArbitratedPlayers(scenario);
  // The driver can write what a modified client could.
  await useTestCoordinators(driver, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);
  const balanceOf = (p: typeof customer, expected: number) => retryUntil(() => call(p, "ledger")<number>("get_balance", p.agentPubKey), (b) => b === expected, 40, 500);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester", "Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(customer, "catalog")<HcRecord>("publish_catalog", { business_name: "Cara's", location: ST_PETE }));
  const item = actionHash(await call(customer, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Empanadas", price_cents: FOOD, available: true }));
  await sync();

  /// An order with this driver on their way to the store.
  async function driverEnRoute() {
    const order = actionHash(
      await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: customer.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity: 1 }], order_total: FOOD, dropoff: ST_PETE, max_delivery_fee: null }),
    );
    await sync();
    await acceptOrder(customer, order, all);
    const bid = await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, price_offer: FEE });
    assert.equal(decodeEntry<{ collateral: number }>(bid).collateral, FOOD, "a bid commits the value of the order's food");
    await sync();
    await call(customer, "dispatch")("accept_bid", { order_original_action: order, bid_action: actionHash(bid) });
    await call(customer, "dispatch")("set_order_status", { order_original_action: order, next_status: "MerchantConfirmed" });
    await sync();
    await call(driver, "dispatch")("set_order_status", { order_original_action: order, next_status: "DriverEnRouteToMerchant" });
    return order;
  }

  /// A dispute over `order`, ruled by the arbitrator.
  async function rule(order: Uint8Array, outcome: unknown) {
    const disputed = await call(customer, "dispatch")<HcRecord>("raise_dispute", { order_original_action: order, reason: "NeverDelivered", description: "", evidence_refs: [] });
    const dispute = decodeEntry<{ dispute_ref: Uint8Array }>(disputed).dispute_ref;
    await sync();
    await call(arbitrator, "dispute")("submit_resolution", { dispute_original_action: dispute, outcome, reasoning: "" });
    await sync();
    const resolved = decodeEntry<{ status: string; dispute_ref: Uint8Array }>(await call(arbitrator, "dispatch")<HcRecord>("apply_dispute_resolution", { order_original_action: order }));
    await sync();
    // The order now names the dispute's resolved version -- what a forfeit cites.
    return { ruling: resolved.dispute_ref, status: resolved.status };
  }

  // --- No pickup without the collateral. ---
  const unsecured = await driverEnRoute();
  await assert.rejects(
    call(driver, "dispatch")("force_order_update_for_testing", { order_original_action: unsecured, next_status: "PickedUp", delivery_receipts: [], dispute_ref: null }),
    /picking an order up requires the driver's collateral hold/,
    "validation refuses a pickup that posts nothing",
  );
  console.log("[PASS] a driver can't pick an order up without posting their collateral");

  // --- Posted at pickup, returned once the delivery settles. ---
  const pickedUp = decodeEntry<{ status: string; collateral_hold: Uint8Array | null }>(await call(driver, "dispatch")<HcRecord>("pick_up_order", unsecured));
  assert.equal(pickedUp.status, "PickedUp");
  assert.ok(pickedUp.collateral_hold, "the pickup records the hold");
  await sync();
  assert.equal(await balanceOf(driver, -FOOD), -FOOD, "the driver has posted the value of the food");
  assert.equal(await balanceOf(customer, FOOD), FOOD, "and the customer holds it");
  console.log("[PASS] at pickup the driver posts the food's value to the customer");

  assert.equal((await rule(unsecured, { FavorProvider: { forfeit_amount: 0 } })).status, "Delivered");
  assert.equal(await balanceOf(driver, FEE), FEE, "settled, the driver has their collateral back and their fee");
  assert.equal(await balanceOf(customer, -FEE), -FEE);
  console.log("[PASS] when the delivery settles, the collateral goes back to the driver");

  // --- Ruled for the customer: they keep it, and that's all that moves. ---
  const lost = await driverEnRoute();
  await call(driver, "dispatch")("pick_up_order", lost);
  await sync();
  const { ruling, status } = await rule(lost, { FavorRequester: { forfeit_amount: 0 } });
  assert.equal(status, "Cancelled");
  assert.equal(await balanceOf(driver, FEE - FOOD), FEE - FOOD, "the driver's collateral stays with the customer");
  assert.equal(await balanceOf(customer, FOOD - FEE), FOOD - FEE);
  await assert.rejects(
    call(arbitrator, "ledger")("forfeit", { related_order: lost, dispute: ruling, from: driver.agentPubKey, to: customer.agentPubKey, amount: 5000 }),
    /the driver's posted collateral is the forfeit/,
    "an arbitrator can't take more than the driver posted",
  );
  console.log("[PASS] a ruling for the customer forfeits the driver's collateral -- and no more");
});
