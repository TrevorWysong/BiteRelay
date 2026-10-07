// Proves the ledger/reputation checkpoint mechanism (architecture plan §9.4)
// actually engages and is correct, not just that get_balance/
// get_reputation_summary happen to be right via the full-scan fallback
// (which would mask a completely broken checkpoint write path). Drives real
// transactions/events -- from customer's own conductor only, so no dhtSync
// is needed in the hot loop: GetStrategy::Local reads see data the querying
// conductor itself authored, and customer authors every transaction/event
// here -- until CHECKPOINT_INTERVAL's deterministic, counting-free trigger
// actually fires (confirmed via the count_*_checkpoints introspection
// functions, not inferred), then confirms the checkpoint-plus-remainder
// balance/summary still matches a manually-tracked expected total, both
// right at the checkpoint and a few operations past it.
import assert from "node:assert/strict";
import { runScenario, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, ST_PETE } from "./helpers.js";

const MAX_ITERATIONS = 150; // generous margin over CHECKPOINT_INTERVAL=20's expected ~20 draws

await runScenario(async (scenario) => {
  const [customer, driver] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);

  const catalogOf = getZomeCaller(customer.cells[0], "catalog");
  const dispatchOf = getZomeCaller(customer.cells[0], "dispatch");
  const ledgerOf = getZomeCaller(customer.cells[0], "ledger");
  const reputationOf = getZomeCaller(customer.cells[0], "reputation");

  // A real, existing record for the ledger's related_order to point at --
  // ledger validation only checks that the reference resolves to
  // *something* real, not that it's specifically a DeliveryOrder, so any
  // cheaply-created entry works there. (Reputation is stricter, see below.)
  const catalogRecord = await catalogOf<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE });
  const dummyRef = catalogRecord.signed_action.hashed.hash;

  // --- Ledger: drive transactions until a checkpoint fires. ---
  let ledgerCount = 0;
  let checkpointsAtLedger = 0;
  while (ledgerCount < MAX_ITERATIONS && checkpointsAtLedger === 0) {
    await ledgerOf("release_on_completion", {
      order_ref: dummyRef,
      from: customer.agentPubKey,
      to: driver.agentPubKey,
      amount: 10,
    });
    ledgerCount++;
    checkpointsAtLedger = await ledgerOf<number>("count_balance_checkpoints", driver.agentPubKey);
  }
  assert.ok(checkpointsAtLedger > 0, `a BalanceCheckpoint should have fired within ${MAX_ITERATIONS} transactions`);
  console.log(`[PASS] BalanceCheckpoint fired after ${ledgerCount} transactions`);

  const expectedDriverBalanceAtCheckpoint = ledgerCount * 10;
  const driverBalanceAtCheckpoint = await ledgerOf<number>("get_balance", driver.agentPubKey);
  const customerBalanceAtCheckpoint = await ledgerOf<number>("get_balance", customer.agentPubKey);
  assert.equal(driverBalanceAtCheckpoint, expectedDriverBalanceAtCheckpoint, "checkpoint-based balance should match the manually-tracked total");
  assert.equal(customerBalanceAtCheckpoint, -expectedDriverBalanceAtCheckpoint, "mutual-credit ledger must always net to zero");
  console.log("[PASS] get_balance via the checkpoint-based path matches the expected total");

  // A few more transactions *past* the checkpoint, to prove the
  // "checkpoint + remainder" summing is correct, not just the checkpoint
  // value alone.
  const EXTRA_TXNS = 3;
  for (let i = 0; i < EXTRA_TXNS; i++) {
    await ledgerOf("release_on_completion", {
      order_ref: dummyRef,
      from: customer.agentPubKey,
      to: driver.agentPubKey,
      amount: 10,
    });
  }
  const expectedDriverBalanceAfterExtra = (ledgerCount + EXTRA_TXNS) * 10;
  const driverBalanceAfterExtra = await ledgerOf<number>("get_balance", driver.agentPubKey);
  assert.equal(driverBalanceAfterExtra, expectedDriverBalanceAfterExtra, "balance must include transactions after the checkpoint too");
  console.log("[PASS] get_balance correctly sums the checkpoint plus transactions recorded since it");

  // --- Reputation: same proof, same shape. ---
  // Unlike the ledger, a reputation event must reference a real order (see
  // `validate_event`), so place one -- customer ordering from their own
  // store keeps every author on customer's own conductor. Customer is the
  // counterparty on every event below, about driver as a `Driver` target.
  const itemRecord = await catalogOf<HcRecord>("add_menu_item", { catalog_ref: dummyRef, name: "Empanada", price_cents: 600, available: true });
  const orderRecord = await dispatchOf<HcRecord>("request_pickup_order", {
    merchant: customer.agentPubKey,
    catalog_ref: dummyRef,
    item_refs: [itemRecord.signed_action.hashed.hash],
    order_total: 600,
  });
  const orderRef = orderRecord.signed_action.hashed.hash;
  const driverTarget = { Driver: driver.agentPubKey };
  let reputationCount = 0;
  let checkpointsAtReputation = 0;
  while (reputationCount < MAX_ITERATIONS && checkpointsAtReputation === 0) {
    await reputationOf("record_event", {
      target: driverTarget,
      order_ref: orderRef,
      kind: "OrderCompleted",
    });
    reputationCount++;
    checkpointsAtReputation = await reputationOf<number>("count_reputation_checkpoints", driverTarget);
  }
  assert.ok(checkpointsAtReputation > 0, `a ReputationCheckpoint should have fired within ${MAX_ITERATIONS} events`);
  console.log(`[PASS] ReputationCheckpoint fired after ${reputationCount} events`);

  const summaryAtCheckpoint = await reputationOf<{ completed_count: number }>("get_reputation_summary", driverTarget);
  assert.equal(summaryAtCheckpoint.completed_count, reputationCount, "checkpoint-based summary should match the manually-tracked count");
  console.log("[PASS] get_reputation_summary via the checkpoint-based path matches the expected count");

  for (let i = 0; i < EXTRA_TXNS; i++) {
    await reputationOf("record_event", {
      target: driverTarget,
      order_ref: orderRef,
      kind: "OrderCompleted",
    });
  }
  const summaryAfterExtra = await reputationOf<{ completed_count: number }>("get_reputation_summary", driverTarget);
  assert.equal(summaryAfterExtra.completed_count, reputationCount + EXTRA_TXNS, "summary must include events after the checkpoint too");
  console.log("[PASS] get_reputation_summary correctly sums the checkpoint plus events recorded since it");
});
