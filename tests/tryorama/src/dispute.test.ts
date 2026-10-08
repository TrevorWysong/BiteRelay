// Proves the dispute/arbitration subsystem (architecture plan §8) end to
// end, both outcomes. Unlike every other test file, all three players
// (customer, driver, arbitrator) must be installed with an *identical*
// DNA-properties override baking in the arbitrator's own AgentPubKey --
// `properties` is part of the DNA hash (unlike the separate, per-install-
// only `init_properties` mechanism), so all three need the same value to
// even land on the same network. That pubkey doesn't exist until runtime,
// so this test pre-generates it via each conductor's own admin websocket
// (`addConductor` + `generateAgentPubKey`, not the `addPlayersWithApps`
// convenience the other test files use) before installing anything.
import assert from "node:assert/strict";
import { runScenario, getZomeCaller, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, retryUntilOk, setupArbitratedPlayers, ST_PETE, acceptOrder } from "./helpers.js";

await runScenario(async (scenario) => {
  const { customer, driver, arbitrator, all } = await setupArbitratedPlayers(scenario);

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");
  const disputeOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispute");
  const ledgerOf = (p: typeof customer) => getZomeCaller(p.cells[0], "ledger");
  const reputationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "reputation");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", {
    catalog_ref: catalogRef,
    name: "Empanada",
    price_cents: 600,
    available: true,
  });
  const menuItemRef = actionHash(menuItemRecord);

  async function driveToPickedUp() {
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
    await acceptOrder(customer, orderRef, all);

    const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
      order_ref: orderRef,
      eta_seconds: 900,
      price_offer: 400,
      collateral_commitment: { account: "stub", amount: 100, ledger_txn_ref: "pending" },
    });
    const bidRef = actionHash(bidRecord);
    await dhtSync(all, customer.cells[0].cell_id[0]);

    await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
    await dispatchOf(customer)("set_order_status", { order_original_action: orderRef, next_status: "MerchantConfirmed" });
    await dhtSync(all, customer.cells[0].cell_id[0]);

    await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "DriverEnRouteToMerchant" });
    await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "PickedUp" });
    await dhtSync(all, customer.cells[0].cell_id[0]);
    return orderRef;
  }

  // --- Scenario 1: FavorProvider -- the arbitrator sides with the driver. ---
  const orderRefA = await driveToPickedUp();
  const disputedOrderA = await dispatchOf(customer)<HcRecord>("raise_dispute", {
    order_original_action: orderRefA,
    reason: "NeverDelivered",
    description: "Driver never arrived",
    evidence_refs: [],
  });
  const disputeRefA = decodeEntry<{ dispute_ref: Uint8Array }>(disputedOrderA).dispute_ref;
  await dhtSync(all, customer.cells[0].cell_id[0]);
  console.log("[PASS] Dispute raised, order moved to Disputed");

  await assert.rejects(
    disputeOf(driver)("submit_resolution", {
      dispute_original_action: disputeRefA,
      outcome: { FavorProvider: { forfeit_amount: 0 } },
      reasoning: "I'm the driver, not an arbitrator",
    }),
    "a non-arbitrator must not be able to resolve a dispute",
  );
  console.log("[PASS] validate() rejects a resolution from a non-arbitrator");

  await disputeOf(arbitrator)("submit_resolution", {
    dispute_original_action: disputeRefA,
    outcome: { FavorProvider: { forfeit_amount: 0 } },
    reasoning: "Delivery confirmed via out-of-band evidence",
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const resolvedOrderA = await dispatchOf(arbitrator)<HcRecord>("apply_dispute_resolution", { order_original_action: orderRefA });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  assert.equal(decodeEntry<{ status: string }>(resolvedOrderA).status, "Delivered");
  console.log("[PASS] FavorProvider ruling applied: order moved to Delivered");

  const customerBalanceA = await retryUntilOk(() => ledgerOf(customer)<number>("get_balance", customer.agentPubKey));
  const driverBalanceA = await retryUntilOk(() => ledgerOf(driver)<number>("get_balance", driver.agentPubKey));
  assert.equal(driverBalanceA, 400, "driver should have been paid the bid's price_offer");
  assert.equal(customerBalanceA + driverBalanceA, 0, "mutual-credit ledger must always net to zero");
  console.log("[PASS] Payment settled on FavorProvider ruling, net-zero across both parties");

  const driverReputationA = await retryUntilOk(async () => {
    const summary = await reputationOf(driver)<{ dispute_resolved_against_count: number }>("get_reputation_summary", { Driver: driver.agentPubKey });
    assert.equal(summary.dispute_resolved_against_count, 0, "the winning side should not carry a DisputeResolvedAgainst event");
    return summary;
  });
  const customerReputationA = await retryUntilOk(async () => {
    const summary = await reputationOf(customer)<{ dispute_raised_count: number; dispute_resolved_against_count: number }>(
      "get_reputation_summary",
      { Customer: customer.agentPubKey },
    );
    assert.equal(summary.dispute_resolved_against_count, 1, "the customer raised in error and lost the ruling");
    return summary;
  });
  assert.equal(driverReputationA.dispute_resolved_against_count, 0);
  console.log("[PASS] Reputation events recorded on the losing side only");

  // --- Scenario 2: FavorRequester -- the arbitrator sides with the customer. ---
  const orderRefB = await driveToPickedUp();
  const disputedOrderB = await dispatchOf(driver)<HcRecord>("raise_dispute", {
    order_original_action: orderRefB,
    reason: "Other",
    description: "Customer is refusing to acknowledge delivery",
    evidence_refs: [],
  });
  const disputeRefB = decodeEntry<{ dispute_ref: Uint8Array }>(disputedOrderB).dispute_ref;
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await disputeOf(arbitrator)("submit_resolution", {
    dispute_original_action: disputeRefB,
    outcome: { FavorRequester: { forfeit_amount: 50 } },
    reasoning: "Driver's own location trace shows they never reached the dropoff",
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const resolvedOrderB = await dispatchOf(arbitrator)<HcRecord>("apply_dispute_resolution", { order_original_action: orderRefB });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  assert.equal(decodeEntry<{ status: string }>(resolvedOrderB).status, "Cancelled");
  console.log("[PASS] FavorRequester ruling applied: order moved to Cancelled");

  const customerBalanceB = await retryUntilOk(() => ledgerOf(customer)<number>("get_balance", customer.agentPubKey));
  const driverBalanceB = await retryUntilOk(() => ledgerOf(driver)<number>("get_balance", driver.agentPubKey));
  // No payment for this order (skipped entirely), only the forfeiture moves:
  // driver -50, customer +50, relative to their balances after scenario 1.
  assert.equal(driverBalanceB, 400 - 50, "driver should have forfeited the ruled amount, no payment for this order");
  assert.equal(customerBalanceB, -400 + 50, "customer should have received the forfeited amount");
  assert.equal(customerBalanceB + driverBalanceB, 0, "mutual-credit ledger must always net to zero");
  console.log("[PASS] Collateral forfeited on FavorRequester ruling, net-zero across both parties");

  const driverReputationB = await retryUntilOk(async () => {
    const summary = await reputationOf(driver)<{ dispute_resolved_against_count: number; total_collateral_forfeited: number }>(
      "get_reputation_summary",
      { Driver: driver.agentPubKey },
    );
    assert.equal(summary.dispute_resolved_against_count, 1, "the driver lost this ruling");
    assert.equal(summary.total_collateral_forfeited, 50);
    return summary;
  });
  assert.equal(driverReputationB.total_collateral_forfeited, 50);
  console.log("[PASS] Reputation + forfeiture events recorded against the losing provider");
});
