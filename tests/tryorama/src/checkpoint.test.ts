// Proves the reputation checkpoint mechanism actually engages and is
// correct, not just that get_reputation_summary happens to be right via the
// full-scan fallback (which would mask a broken checkpoint write path):
// drives real events until a checkpoint fires, then checks the
// checkpoint-plus-remainder summary against a tracked total, at the
// checkpoint and a few events past it. (Ledger checkpoints: see
// balance-consistency.test.ts.)
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
  const reputationOf = getZomeCaller(customer.cells[0], "reputation");

  const dummyRef = (await catalogOf<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE })).signed_action.hashed.hash;

  // A few events past a checkpoint, to prove "checkpoint + remainder" sums
  // correctly, not just the checkpoint alone.
  const EXTRA_TXNS = 3;

  // --- Reputation ---
  // Unlike the ledger, a reputation event must reference a real order (see
  // `validate_event`), so place one -- customer ordering from their own
  // store keeps every author on customer's own conductor. Customer is the
  // counterparty on every event below, about driver as a `Driver` target.
  const itemRecord = await catalogOf<HcRecord>("add_menu_item", { catalog_ref: dummyRef, name: "Empanada", price_cents: 600, available: true });
  const orderRecord = await dispatchOf<HcRecord>("request_pickup_order", {
    merchant: customer.agentPubKey,
    catalog_ref: dummyRef,
    items: [{ item_ref: itemRecord.signed_action.hashed.hash, quantity: 1 }],
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
