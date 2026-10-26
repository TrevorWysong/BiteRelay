// Proves delivery handoffs: the driver records each one and the other
// party acknowledges it, each signed on their own chain -- and validation,
// not the honest coordinator, holds them to it: a handoff only by the
// order's assigned driver, only with that order's store or customer; an
// acknowledgment only by the handoff's other party. Forgeries are written
// raw (test-utils), the way a modified client could.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, commitAndCook, decodeEntry, pickUp, ST_PETE, testApp, useTestCoordinators, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver, stranger] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
    testApp,
    testApp,
  ]);
  const all = [customer, merchant, driver, stranger];
  await scenario.shareAllAgents();
  for (const p of [driver, stranger]) await useTestCoordinators(p, ["attestation"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Soup", price_cents: 600, available: true }));
  await sync();

  const order = actionHash(
    await call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity: 1 }], order_total: 600, dropoff: ST_PETE, max_delivery_fee: null }),
  );
  await sync();
  await acceptOrder(merchant, order, all);
  const bid = actionHash(await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, price_offer: 400 }));
  await sync();
  await call(customer, "dispatch")("accept_bid", { order_original_action: order, bid_action: bid });
  await sync();
  await commitAndCook(driver, merchant, order, all);
  // The version of the order naming this driver -- what a handoff cites.
  const current = actionHash(await call(driver, "dispatch")<HcRecord>("get_order", order));
  const leg = (fields: Record<string, unknown>) => ({
    order_ref: current,
    sequence: 0,
    kind: "MerchantHandoff",
    from: driver.agentPubKey,
    to: merchant.agentPubKey,
    completed_at: Date.now() * 1000,
    // Sealed evidence isn't what these cases are about.
    sealed_evidence: [{ nonce: new Uint8Array(24), encrypted_data: new Uint8Array(32) }],
    ...fields,
  });

  // --- Only the assigned driver records a handoff, only with the order's own parties. ---
  await assert.rejects(call(stranger, "attestation")("create_raw_leg_for_testing", leg({ from: stranger.agentPubKey })), /only the order's assigned driver records its handoffs/);
  await assert.rejects(call(driver, "attestation")("create_raw_leg_for_testing", leg({ to: stranger.agentPubKey })), /with the order's own store or customer/);
  await assert.rejects(call(driver, "attestation")("create_raw_leg_for_testing", leg({ kind: "CustomerHandoff", sequence: 1 })), /with the order's own store or customer/, "a drop-off is with the customer, not the store");
  await assert.rejects(call(stranger, "attestation")("create_raw_leg_for_testing", leg({})), /recorded by the driver who made it/, "nobody records a handoff in the driver's name");
  console.log("[PASS] validation takes a handoff only from the order's driver, with its own store or customer");

  // --- The driver records collecting it; the store acknowledges, on its own chain. ---
  const pickup = await call(driver, "attestation")<HcRecord>("record_leg", { order_ref: order, sequence: 0, kind: "MerchantHandoff", to: merchant.agentPubKey, geo_at_completion: ST_PETE });
  const pickupRef = actionHash(pickup);
  assert.ok(Buffer.from(decodeEntry<{ order_ref: Uint8Array }>(pickup).order_ref).equals(Buffer.from(current)), "it cites the version of the order naming the driver");
  await sync();
  await assert.rejects(call(customer, "attestation")("acknowledge_leg", pickupRef), /Only the other party to a handoff can confirm it/);
  await assert.rejects(call(stranger, "attestation")("create_raw_receipt_for_testing", { leg: pickupRef, attested_at: Date.now() * 1000 }), /acknowledged by the other party to it/, "even written directly");
  const receipt = actionHash(await call(merchant, "attestation")<HcRecord>("acknowledge_leg", pickupRef));
  const again = actionHash(await call(merchant, "attestation")<HcRecord>("acknowledge_leg", pickupRef));
  assert.ok(Buffer.from(again).equals(Buffer.from(receipt)), "acknowledging again returns the same receipt");
  await sync();
  const found = await call(driver, "attestation")<HcRecord | null>("get_receipt_for_leg", pickupRef);
  assert.ok(found && Buffer.from(actionHash(found)).equals(Buffer.from(receipt)), "the store's acknowledgment is found under the handoff");
  console.log("[PASS] the store acknowledges the driver's pickup on its own chain, once");

  // --- Each side writes in its own time: no shared session to fail. ---
  await pickUp(driver, order);
  const dropoff = actionHash(await call(driver, "attestation")<HcRecord>("record_leg", { order_ref: order, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE }));
  const legs = await call(customer, "attestation")<HcRecord[]>("get_legs_for_order", order);
  assert.ok(legs.length >= 1, "the customer finds the order's handoffs");
  await sync();
  await call(customer, "attestation")("acknowledge_leg", dropoff);
  const proof = await call(customer, "attestation")<Uint8Array | null>("delivery_proof_for_order", order);
  const theirs = await call(customer, "attestation")<HcRecord | null>("get_receipt_for_leg", dropoff);
  assert.ok(proof && theirs && Buffer.from(proof).equals(Buffer.from(actionHash(theirs))), "a delivery's proof is the customer's acknowledgment");
  console.log("[PASS] a delivery's proof is the customer's acknowledgment");
});
