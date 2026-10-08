// Proves the dispute/arbitration subsystem is enforced by
// dispatch_integrity::validate() itself, not just the honest
// raise_dispute/submit_resolution/apply_dispute_resolution coordinator path
// -- same style as completion-gate.test.ts's bypass proof, via the same
// force_order_update_for_testing extern (now extended to also accept a
// caller-chosen dispute_ref).
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, decodeEntry, setupArbitratedPlayers, ST_PETE, useTestCoordinators, acceptOrder } from "./helpers.js";

await runScenario(async (scenario) => {
  const { customer, driver, arbitrator, all } = await setupArbitratedPlayers(scenario);
  // force_order_update_for_testing only exists in the test-utils build.
  for (const player of all) await useTestCoordinators(player, ["dispatch"]);

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");
  const disputeOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispute");

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

  async function driveToDisputed(description: string) {
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

    const disputedOrder = await dispatchOf(customer)<HcRecord>("raise_dispute", {
      order_original_action: orderRef,
      reason: "NeverDelivered",
      description,
      evidence_refs: [],
    });
    const disputeRef = decodeEntry<{ dispute_ref: Uint8Array }>(disputedOrder).dispute_ref;
    await dhtSync(all, customer.cells[0].cell_id[0]);
    return { orderRef, disputeRef };
  }

  // --- Case A: dispute_ref pointing at a still-Open (unresolved) dispute. ---
  const { orderRef: orderRefA, disputeRef: disputeRefA } = await driveToDisputed("Case A: unresolved dispute");
  await assert.rejects(
    dispatchOf(arbitrator)("force_order_update_for_testing", {
      order_original_action: orderRefA,
      next_status: "Delivered",
      delivery_receipts: [],
      dispute_ref: disputeRefA,
    }),
    /Resolved/,
    "an unresolved dispute must not satisfy the resolution gate",
  );
  console.log("[PASS] validate() rejects a resolution transition backed by a still-Open dispute");

  // Now genuinely resolve it (FavorProvider), for cases B-D below.
  await disputeOf(arbitrator)("submit_resolution", {
    dispute_original_action: disputeRefA,
    outcome: { FavorProvider: { forfeit_amount: 0 } },
    reasoning: "Confirmed via out-of-band evidence",
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const resolvedDisputeRecord = await disputeOf(arbitrator)<HcRecord>("get_dispute", disputeRefA);
  const resolvedDisputeRef = actionHash(resolvedDisputeRecord);

  // --- Case B: absent dispute_ref while leaving Disputed. ---
  await assert.rejects(
    dispatchOf(arbitrator)("force_order_update_for_testing", {
      order_original_action: orderRefA,
      next_status: "Delivered",
      delivery_receipts: [],
      dispute_ref: null,
    }),
    "an absent dispute_ref must not satisfy the resolution gate",
  );
  console.log("[PASS] validate() rejects a resolution transition with no dispute_ref at all");

  // --- Case C: outcome/target mismatch -- real FavorProvider ruling, wrong target. ---
  await assert.rejects(
    dispatchOf(arbitrator)("force_order_update_for_testing", {
      order_original_action: orderRefA,
      next_status: "Cancelled",
      delivery_receipts: [],
      dispute_ref: resolvedDisputeRef,
    }),
    /outcome/,
    "a FavorProvider ruling must not be applicable to a Cancelled target",
  );
  console.log("[PASS] validate() rejects an outcome/target mismatch (FavorProvider ruling, Cancelled target)");

  // --- Case D: a non-arbitrator applying an otherwise-correct, genuinely-resolved ruling. ---
  await assert.rejects(
    dispatchOf(driver)("force_order_update_for_testing", {
      order_original_action: orderRefA,
      next_status: "Delivered",
      delivery_receipts: [],
      dispute_ref: resolvedDisputeRef,
    }),
    "a non-arbitrator must not be able to apply a resolution, even a genuinely correct one",
  );
  console.log("[PASS] validate() rejects a resolution transition authored by a non-arbitrator");

  // Positive control: the same real ruling, applied correctly, still works --
  // confirms the above rejections are about the specific defect each
  // introduces, not an over-broad break in the resolution path itself.
  const resolvedOrder = await dispatchOf(arbitrator)<HcRecord>("force_order_update_for_testing", {
    order_original_action: orderRefA,
    next_status: "Delivered",
    delivery_receipts: [],
    dispute_ref: resolvedDisputeRef,
  });
  assert.equal(decodeEntry<{ status: string }>(resolvedOrder).status, "Delivered");
  console.log("[PASS] The same genuine ruling, applied correctly by the real arbitrator, succeeds");
});
