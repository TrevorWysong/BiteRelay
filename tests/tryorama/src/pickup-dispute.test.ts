// Proves pickup-order disputes end to end, reusing the `dispute` zome
// entirely unchanged (see `PickupOrder`'s own doc comment for why "Provider"
// is reinterpreted as "merchant" here -- there's no driver at all for this
// vertical). Mirrors cancellation-dispute.test.ts's own two-scenario shape.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, decodeEntry, setupArbitratedPlayers, ST_PETE, retryUntil } from "./helpers.js";

await runScenario(async (scenario) => {
  // setupArbitratedPlayers names its second player "driver" (generic
  // infra, not semantically binding) -- here it plays the merchant, since
  // PickupOrder has no driver concept at all.
  const { customer, driver: merchant, arbitrator, all } = await setupArbitratedPlayers(scenario);

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");
  const disputeOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispute");
  const ledgerOf = (p: typeof customer) => getZomeCaller(p.cells[0], "ledger");
  // Each party's conductor settles the held money on its own.
  const balanceOnceSettled = (p: typeof customer, expected: number) => retryUntil(() => ledgerOf(p)<number>("get_balance", p.agentPubKey), (b) => b === expected, 120, 1000);
  const reputationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "reputation");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 600, available: true });
  const menuItemRef = actionHash(menuItemRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  async function driveToReadyForPickup() {
    const orderRecord = await dispatchOf(customer)<HcRecord>("request_pickup_order", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: menuItemRef, quantity: 1 }],
      order_total: 600,
    });
    const orderRef = actionHash(orderRecord);
    await dhtSync(all, customer.cells[0].cell_id[0]);
    await dispatchOf(merchant)("accept_pickup_order", { order_original_action: orderRef });
    await dhtSync(all, customer.cells[0].cell_id[0]);
    await dispatchOf(merchant)("mark_ready_for_pickup", orderRef);
    await dhtSync(all, customer.cells[0].cell_id[0]);
    return orderRef;
  }

  // --- Scenario 1: FavorProvider (merchant) -- order completes, customer pays. ---
  const orderRefA = await driveToReadyForPickup();
  const disputedOrderA = await dispatchOf(customer)<HcRecord>("raise_pickup_dispute", {
    order_original_action: orderRefA,
    reason: "NeverDelivered",
    description: "Never got a confirmation it was ready",
    evidence_refs: [],
  });
  const disputedA = decodeEntry<{ status: string; dispute_ref: Uint8Array }>(disputedOrderA);
  assert.equal(disputedA.status, "Disputed");
  await dhtSync(all, customer.cells[0].cell_id[0]);
  console.log("[PASS] raise_pickup_dispute moves a ReadyForPickup order to Disputed");

  await disputeOf(arbitrator)("submit_resolution", {
    dispute_original_action: disputedA.dispute_ref,
    outcome: "FavorProvider",
    reasoning: "Merchant's own records show it was ready on time",
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const resolvedA = await dispatchOf(arbitrator)<HcRecord>("apply_pickup_dispute_resolution", { order_original_action: orderRefA });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  assert.equal(decodeEntry<{ status: string }>(resolvedA).status, "PickedUp");

  const merchantBalanceA = await balanceOnceSettled(merchant, 600);
  const customerBalanceA = await ledgerOf(customer)<number>("get_balance", customer.agentPubKey);
  assert.equal(merchantBalanceA, 600, "FavorProvider lets the store collect the held order_total, same as an honest complete_pickup");
  assert.equal(customerBalanceA, -600);
  console.log("[PASS] FavorProvider resolves to PickedUp and settles order_total");

  await assert.rejects(
    dispatchOf(arbitrator)("apply_pickup_dispute_resolution", { order_original_action: orderRefA }),
    "applying the same pickup-dispute resolution twice must fail",
  );
  console.log("[PASS] validate() rejects replaying the same pickup-dispute resolution");

  // --- Scenario 2: FavorRequester (customer) -- order cancels, the customer has their money back. ---
  const orderRefB = await driveToReadyForPickup();
  const disputedOrderB = await dispatchOf(merchant)<HcRecord>("raise_pickup_dispute", {
    order_original_action: orderRefB,
    reason: "Other",
    description: "Customer never showed up to collect, raising on their behalf per policy",
    evidence_refs: [],
  });
  const disputedB = decodeEntry<{ dispute_ref: Uint8Array }>(disputedOrderB);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await assert.rejects(
    dispatchOf(merchant)("apply_pickup_dispute_resolution", { order_original_action: orderRefB }),
    "a non-arbitrator must not be able to apply a pickup-dispute resolution",
  );

  await disputeOf(arbitrator)("submit_resolution", {
    dispute_original_action: disputedB.dispute_ref,
    outcome: "FavorRequester",
    reasoning: "Order was actually never properly prepared",
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const resolvedB = await dispatchOf(arbitrator)<HcRecord>("apply_pickup_dispute_resolution", { order_original_action: orderRefB });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  assert.equal(decodeEntry<{ status: string }>(resolvedB).status, "Cancelled");

  assert.equal(await balanceOnceSettled(customer, -600), -600, "FavorRequester returns the customer's held payment");
  assert.equal(await ledgerOf(merchant)<number>("get_balance", merchant.agentPubKey), 600, "and the store collects nothing for it");
  console.log("[PASS] FavorRequester resolves to Cancelled and returns the customer's money; the store collects nothing");

  const merchantReputation = await reputationOf(merchant)<{ dispute_resolved_against_count: number }>("get_reputation_summary", { Store: catalogRef });
  assert.equal(merchantReputation.dispute_resolved_against_count, 1, "merchant lost scenario 2 only");
  const customerReputation = await reputationOf(customer)<{ dispute_resolved_against_count: number }>("get_reputation_summary", { Customer: customer.agentPubKey });
  assert.equal(customerReputation.dispute_resolved_against_count, 1, "customer lost scenario 1 only");
  console.log("[PASS] Reputation events recorded correctly across both scenarios");
});
