// Proves a driver's collateral is real: a bid commits the value of the
// order's food, the driver sets it aside at pickup (validation won't accept
// a pickup without it), it comes back when the delivery is settled, and a
// ruling for the customer gives it to the store, which handed over the
// food -- which is then all the driver can lose.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, decodeEntry, latestLedgerEntry, retryUntil, setupArbitratedPlayers, ST_PETE, useTestCoordinators } from "./helpers.js";

const FOOD = 600;
const FEE = 400;

interface HoldView {
  hold: Uint8Array;
  purpose: unknown;
}

await runScenario(async (scenario) => {
  // The customer runs the store too, so the only money moving is between
  // them and the driver.
  const { customer, driver, arbitrator, all } = await setupArbitratedPlayers(scenario);
  // The driver can write what a modified client could.
  await useTestCoordinators(driver, ["dispatch", "ledger"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);
  const balanceOf = (p: typeof customer, expected: number) => retryUntil(() => call(p, "ledger")<number>("get_balance", p.agentPubKey), (b) => b === expected, 120, 1000);

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
    const applied = await call(arbitrator, "dispatch")<HcRecord>("apply_dispute_resolution", { order_original_action: order });
    await sync();
    // The arbitrator's update of the order -- what the parties settle by.
    return { ruling: actionHash(applied), status: decodeEntry<{ status: string }>(applied).status };
  }

  // --- No pickup without the collateral. ---
  const unsecured = await driverEnRoute();
  await assert.rejects(
    call(driver, "dispatch")("force_order_update_for_testing", { order_original_action: unsecured, next_status: "PickedUp", delivery_receipts: [], dispute_ref: null }),
    /needs its Collateral .* hold/,
    "validation refuses a pickup that posts nothing",
  );
  console.log("[PASS] a driver can't pick an order up without posting their collateral");

  // --- Posted at pickup, returned once the delivery settles. ---
  const pickedUp = decodeEntry<{ status: string; collateral_hold: Uint8Array | null }>(await call(driver, "dispatch")<HcRecord>("pick_up_order", unsecured));
  assert.equal(pickedUp.status, "PickedUp");
  assert.ok(pickedUp.collateral_hold, "the pickup records the hold");
  await sync();
  assert.equal(await balanceOf(driver, -FOOD), -FOOD, "the driver has set aside the value of the food");
  assert.equal(await balanceOf(customer, -FEE), -FEE, "held for the driver -- the customer (who runs the store) has only paid the fee");
  console.log("[PASS] at pickup the driver sets aside the food's value");

  assert.equal((await rule(unsecured, "FavorProvider")).status, "Delivered");
  assert.equal(await balanceOf(driver, FEE), FEE, "settled, the driver has their collateral back and their fee");
  assert.equal(await balanceOf(customer, -FEE), -FEE);
  console.log("[PASS] when the delivery settles, the collateral goes back to the driver");

  // --- Ruled for the customer: they keep it, and that's all that moves. ---
  const lost = await driverEnRoute();
  await call(driver, "dispatch")("pick_up_order", lost);
  await sync();
  const { ruling, status } = await rule(lost, "FavorRequester");
  assert.equal(status, "Cancelled");
  assert.equal(await balanceOf(customer, FOOD - FEE), FOOD - FEE, "the store collects the collateral, and the customer has their holds back");
  assert.equal(await balanceOf(driver, FEE - FOOD), FEE - FOOD, "the driver's collateral is gone");
  // The driver can't take it back, ruling or not.
  const holds = await call(driver, "ledger")<HoldView[]>("holds_for_order", lost);
  const collateral = holds.find((h) => typeof h.purpose === "object" && h.purpose !== null && "Collateral" in h.purpose)!;
  const latest = await latestLedgerEntry(driver);
  await assert.rejects(
    call(driver, "ledger")("create_raw_ledger_entry_for_testing", { kind: { Collect: { hold: collateral.hold, portion: "Collateral", basis: ruling } }, amount: FOOD, balance: latest.balance + FOOD, previous: latest.hash }),
    /isn't grounds|doesn't entitle/,
    "the driver can't reclaim collateral a ruling gave the store",
  );
  console.log("[PASS] a ruling for the customer gives the driver's collateral to the store -- and that's all the driver loses");
});
