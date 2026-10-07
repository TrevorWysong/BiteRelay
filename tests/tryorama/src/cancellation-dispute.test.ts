// Proves cancellation-fairness disputes (architecture plan §11.1) end to
// end: raising one against an already-Cancelled order, both rulings
// (compensate the provider; dismiss with zero forfeiture), and the replay
// gap found and fixed while building this -- applying a resolution twice
// must fail the second time, and a non-arbitrator must never be able to
// apply one at all.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, decodeEntry, setupArbitratedPlayers, ST_PETE } from "./helpers.js";

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

  async function driveToCancelled() {
    const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
      merchant: customer.agentPubKey,
      catalog_ref: catalogRef,
      item_refs: [menuItemRef],
      order_total: 600,
      dropoff: ST_PETE,
      max_delivery_fee: null,
    });
    const orderRef = actionHash(orderRecord);
    await dhtSync(all, customer.cells[0].cell_id[0]);

    const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
      order_ref: orderRef,
      eta_seconds: 900,
      price_offer: 400,
      collateral_commitment: { account: "stub", amount: 100, ledger_txn_ref: "pending" },
    });
    const bidRef = actionHash(bidRecord);
    await dhtSync(all, customer.cells[0].cell_id[0]);

    await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
    await dispatchOf(customer)("set_order_status", { order_original_action: orderRef, next_status: "Cancelled" });
    await dhtSync(all, customer.cells[0].cell_id[0]);
    return orderRef;
  }

  // --- Scenario 1: FavorProvider -- the cancellation was unfair, driver is compensated. ---
  const orderRefA = await driveToCancelled();
  const disputedOrderA = await dispatchOf(driver)<HcRecord>("raise_cancellation_dispute", {
    order_original_action: orderRefA,
    description: "I was already en route to the merchant when this was cancelled",
    evidence_refs: [],
  });
  assert.equal(decodeEntry<{ status: string }>(disputedOrderA).status, "Cancelled", "status must stay Cancelled when raising a cancellation dispute");
  const disputeRefA = decodeEntry<{ dispute_ref: Uint8Array }>(disputedOrderA).dispute_ref;
  await dhtSync(all, customer.cells[0].cell_id[0]);
  console.log("[PASS] Cancellation-fairness dispute raised; order status unchanged (still Cancelled)");

  await disputeOf(arbitrator)("submit_resolution", {
    dispute_original_action: disputeRefA,
    outcome: { FavorProvider: { forfeit_amount: 50 } },
    reasoning: "Driver's own location trace confirms they had already committed",
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await dispatchOf(arbitrator)("apply_cancellation_dispute_resolution", { order_original_action: orderRefA });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const customerBalanceA = await ledgerOf(customer)<number>("get_balance", customer.agentPubKey);
  const driverBalanceA = await ledgerOf(driver)<number>("get_balance", driver.agentPubKey);
  assert.equal(driverBalanceA, 50, "driver should have been compensated the ruled amount");
  assert.equal(customerBalanceA, -50, "customer should have paid the compensation");
  console.log("[PASS] FavorProvider ruling compensates the driver via ledger::forfeit, net-zero across both parties");

  await assert.rejects(
    dispatchOf(arbitrator)("apply_cancellation_dispute_resolution", { order_original_action: orderRefA }),
    /already been applied/,
    "applying the same cancellation-dispute resolution twice must fail -- otherwise the forfeiture could be replayed",
  );
  console.log("[PASS] validate() rejects replaying the same cancellation-dispute resolution a second time");

  // --- Scenario 2: FavorRequester -- the cancellation was fine, dismissed with zero forfeiture. ---
  const orderRefB = await driveToCancelled();
  const disputedOrderB = await dispatchOf(customer)<HcRecord>("raise_cancellation_dispute", {
    order_original_action: orderRefB,
    description: "Driver never confirmed availability before I had to cancel",
    evidence_refs: [],
  });
  const disputeRefB = decodeEntry<{ dispute_ref: Uint8Array }>(disputedOrderB).dispute_ref;
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // A non-arbitrator (the respondent themselves) must not be able to resolve it.
  await assert.rejects(
    disputeOf(driver)("submit_resolution", {
      dispute_original_action: disputeRefB,
      outcome: { FavorRequester: { forfeit_amount: 0 } },
      reasoning: "trying to rule in my own case",
    }),
    "a non-arbitrator must not be able to resolve a cancellation dispute",
  );

  await disputeOf(arbitrator)("submit_resolution", {
    dispute_original_action: disputeRefB,
    outcome: { FavorRequester: { forfeit_amount: 0 } },
    reasoning: "Cancellation was reasonable given the circumstances",
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // A non-arbitrator must not be able to apply the resolution either, even
  // once it genuinely exists.
  await assert.rejects(
    dispatchOf(driver)("apply_cancellation_dispute_resolution", { order_original_action: orderRefB }),
    "a non-arbitrator must not be able to apply a cancellation-dispute resolution",
  );
  console.log("[PASS] validate() rejects a non-arbitrator applying a cancellation-dispute resolution");

  await dispatchOf(arbitrator)("apply_cancellation_dispute_resolution", { order_original_action: orderRefB });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const driverBalanceB = await ledgerOf(driver)<number>("get_balance", driver.agentPubKey);
  assert.equal(driverBalanceB, 50, "no additional ledger movement on a zero-forfeit dismissal");
  console.log("[PASS] FavorRequester (dismissed, zero forfeiture) ruling applies cleanly with no ledger movement");

  const driverReputation = await reputationOf(driver)<{ dispute_resolved_against_count: number }>("get_reputation_summary", { Driver: driver.agentPubKey });
  assert.equal(driverReputation.dispute_resolved_against_count, 1, "driver won scenario 1 but lost scenario 2's FavorRequester ruling");
  const customerReputation = await reputationOf(customer)<{ dispute_resolved_against_count: number }>("get_reputation_summary", { Customer: customer.agentPubKey });
  assert.equal(customerReputation.dispute_resolved_against_count, 1, "customer lost scenario 1's ruling, won scenario 2's");
  console.log("[PASS] Reputation events recorded correctly across both scenarios");
});
