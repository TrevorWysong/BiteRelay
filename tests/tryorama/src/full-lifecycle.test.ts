// Proves the piece that was missing after matching.test.ts and
// attestation.test.ts: a COMPLETE order actually works start to finish, with
// the zomes that were each individually proven now wired together --
// dispatch gates the Delivered transition on attestation, settles payment
// via ledger, and records a reputation event, not just individually correct
// in isolation.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, collectFromStore, commitAndCook, decodeEntry, retryUntil, retryUntilOk, ST_PETE, testApp, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, driver] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
  ]);
  const both = [customer, driver];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => retryingCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => retryingCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => retryingCaller(p.cells[0], "dispatch");
  const attestationOf = (p: typeof customer) => retryingCaller(p.cells[0], "attestation");
  const ledgerOf = (p: typeof customer) => retryingCaller(p.cells[0], "ledger");
  const reputationOf = (p: typeof customer) => retryingCaller(p.cells[0], "reputation");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", {
    catalog_ref: catalogRef,
    name: "Cuban Sandwich",
    price_cents: 1250,
    available: true,
  });
  const menuItemRef = actionHash(menuItemRecord);

  await dhtSync(both, customer.cells[0].cell_id[0]);

  const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: customer.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 1250,
    dropoff: ST_PETE,
    max_delivery_fee: 500,
  });
  const orderRef = actionHash(orderRecord);
  console.log("[PASS] Order requested and matched (driver was signaled -- see matching.test.ts for that mechanism in isolation)");

  await dhtSync(both, customer.cells[0].cell_id[0]);
  await acceptOrder(customer, orderRef, both);

  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRef,
    eta_seconds: 900,
    price_offer: 400,
  });
  const bidRef = actionHash(bidRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);

  await customer_acceptBidAndAdvance();
  async function customer_acceptBidAndAdvance() {
    await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
  }
  console.log("[PASS] Bid accepted; merchant confirmed prep");

  await dhtSync(both, customer.cells[0].cell_id[0]);

  // From here on, the driver (the accepted provider, not the requester or
  // merchant) advances the order themselves -- this is the authorization
  // fix in dispatch_integrity's validate_order_transition: it used to only
  // allow the requester/merchant to update the order at all.
  await commitAndCook(driver, customer, orderRef, both);

  // The driver records collecting the order; the store (the customer runs
  // it here) acknowledges handing it over.
  await collectFromStore(driver, customer, orderRef, both);
  console.log("[PASS] Store handoff recorded by the driver and acknowledged by the store");

  // The driver records handing it over. Until the customer acknowledges
  // receiving it, the delivery can't complete.
  const dropoffLeg = actionHash(
    await attestationOf(driver)<HcRecord>("record_leg", { order_ref: orderRef, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE }),
  );
  await dhtSync(both, customer.cells[0].cell_id[0]);
  await assert.rejects(
    dispatchOf(customer)("complete_delivery", { order_original_action: orderRef }),
    /no proof yet that the customer has it/,
    "the driver's word alone doesn't complete a delivery",
  );
  await attestationOf(customer)("acknowledge_leg", dropoffLeg);
  console.log("[PASS] Drop-off recorded by the driver and acknowledged by the customer");

  await dhtSync(both, customer.cells[0].cell_id[0]);

  // The actual point of this test: complete_delivery should refuse to
  // finish early, then succeed once both attestations genuinely exist, and
  // settle payment + record reputation as a side effect of the same call.
  await assert.rejects(
    dispatchOf(customer)("set_order_status", { order_original_action: orderRef, next_status: "Delivered" }),
    /recorded by its own step: .*complete_delivery/,
    "set_order_status must refuse to mark Delivered directly",
  );

  const deliveredOrderRecord = await dispatchOf(customer)<HcRecord>("complete_delivery", { order_original_action: orderRef });
  const deliveredOrder = decodeEntry<{ status: string; accepted_bid: Uint8Array }>(deliveredOrderRecord);
  assert.equal(deliveredOrder.status, "Delivered");
  console.log("[PASS] complete_delivery succeeded once both ends of the delivery were acknowledged");

  // The ledger transaction and its two AgentToTransaction links are all
  // authored on the *customer's* chain (they called complete_delivery) --
  // the driver needs gossip to deliver that data before their own
  // GetStrategy::Local balance query can see it.
  await dhtSync(both, customer.cells[0].cell_id[0]);

  const customerBalance = await retryUntil(() => ledgerOf(customer)<number>("get_balance", customer.agentPubKey), (b) => b === -400, 120, 1000);
  const driverBalance = await retryUntil(() => ledgerOf(driver)<number>("get_balance", driver.agentPubKey), (b) => b === 400, 120, 1000);
  assert.equal(customerBalance, -400, "customer should have paid the bid's price_offer");
  assert.equal(driverBalance, 400, "driver should have received the bid's price_offer");
  assert.equal(customerBalance + driverBalance, 0, "mutual-credit ledger must always net to zero");
  console.log("[PASS] Payment settled via the ledger stub, net-zero across both parties");

  const driverReputation = await retryUntilOk(async () => {
    const summary = await reputationOf(driver)<{ completed_count: number }>("get_reputation_summary", { Driver: driver.agentPubKey });
    assert.equal(summary.completed_count, 1);
    return summary;
  });
  assert.equal(driverReputation.completed_count, 1, "driver should have exactly one completed-order reputation event");
  console.log("[PASS] Reputation event recorded for the completing provider");
});
