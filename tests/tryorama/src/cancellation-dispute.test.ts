// Proves cancellation-fairness disputes (architecture plan §11.1) end to
// end: raising one against an already-Cancelled order, both rulings
// (for the provider; dismissed), and the replay
// gap found and fixed while building this -- applying a resolution twice
// must fail the second time, and a non-arbitrator must never be able to
// apply one at all.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, decodeEntry, setupArbitratedPlayers, ST_PETE, acceptOrder, retryUntil } from "./helpers.js";

await runScenario(async (scenario) => {
  const { customer, driver, arbitrator, all } = await setupArbitratedPlayers(scenario);

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");
  const disputeOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispute");
  const ledgerOf = (p: typeof customer) => getZomeCaller(p.cells[0], "ledger");
  // Each party's conductor settles the held money on its own.
  const balanceOnceSettled = (p: typeof customer, expected: number) => retryUntil(() => ledgerOf(p)<number>("get_balance", p.agentPubKey), (b) => b === expected, 120, 1000);
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
    });
    const bidRef = actionHash(bidRecord);
    await dhtSync(all, customer.cells[0].cell_id[0]);

    await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
    await dispatchOf(customer)("cancel_order", orderRef);
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
    outcome: "FavorProvider",
    reasoning: "Driver's own location trace confirms they had already committed",
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await dispatchOf(arbitrator)("apply_cancellation_dispute_resolution", { order_original_action: orderRefA });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // A customer cancelling after accepting a driver owes them their share of
  // the fee ($2.00 of the $4.00 bid) -- held when they accepted the bid,
  // collected by the driver's conductor on the cancellation itself.
  assert.equal(await balanceOnceSettled(driver, 200), 200, "the driver collects the customer's share of the fee");
  assert.equal(await ledgerOf(customer)<number>("get_balance", customer.agentPubKey), -200, "which is all the customer pays");
  console.log("[PASS] a late cancellation pays the driver the customer's share of the fee, ruling or not");

  await assert.rejects(
    dispatchOf(arbitrator)("apply_cancellation_dispute_resolution", { order_original_action: orderRefA }),
    /already been applied/,
    "applying the same cancellation-dispute resolution twice must fail -- otherwise the forfeiture could be replayed",
  );
  console.log("[PASS] validate() rejects replaying the same cancellation-dispute resolution a second time");

  // --- Scenario 2: FavorRequester -- the cancellation was fine. ---
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
      outcome: "FavorRequester",
      reasoning: "trying to rule in my own case",
    }),
    "a non-arbitrator must not be able to resolve a cancellation dispute",
  );

  await disputeOf(arbitrator)("submit_resolution", {
    dispute_original_action: disputeRefB,
    outcome: "FavorRequester",
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

  // The customer cancelled this one themselves, so a ruling for them returns
  // nothing: the driver's fee for it is theirs either way.
  assert.equal(await balanceOnceSettled(driver, 400), 400, "the driver keeps the fee from the second cancellation too");
  assert.equal(await ledgerOf(customer)<number>("get_balance", customer.agentPubKey), -400, "a ruling doesn't refund a cancellation the customer made");
  console.log("[PASS] a ruling for the customer doesn't undo the fee a cancellation they made owes");

  const driverReputation = await reputationOf(driver)<{ dispute_resolved_against_count: number }>("get_reputation_summary", { Driver: driver.agentPubKey });
  assert.equal(driverReputation.dispute_resolved_against_count, 1, "driver won scenario 1 but lost scenario 2's FavorRequester ruling");
  const customerReputation = await reputationOf(customer)<{ dispute_resolved_against_count: number }>("get_reputation_summary", { Customer: customer.agentPubKey });
  assert.equal(customerReputation.dispute_resolved_against_count, 1, "customer lost scenario 1's ruling, won scenario 2's");
  console.log("[PASS] Reputation events recorded correctly across both scenarios");
});
