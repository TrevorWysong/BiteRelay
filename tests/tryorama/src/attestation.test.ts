// Proves the plan's other flagged risk: native Holochain countersigning
// actually completing a dual-signed ReceiptAttestation across two real
// conductors -- preflight exchange, both sides committing the identical
// entry durably to their own chain. This is genuinely untested territory
// (hdk gates it behind "unstable-countersigning"), so this is the isolated
// spike the plan called for, not a mocked assertion.
//
// First pass at this found a real bug: non-enzymatic sessions didn't
// reliably finalize (trial commits succeeded on both sides, but the entry
// never durably landed on either chain -- see initiate_leg_attestation's
// doc comment for the root cause and fix). Fixed by using an enzymatic
// session; this test is what proves that fix actually works.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, bytesEqual, retryUntilOk, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, driver] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const both = [customer, driver];

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");
  const attestationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "attestation");

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

  const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: customer.agentPubKey,
    catalog_ref: catalogRef,
    item_refs: [menuItemRef],
    order_total: 600,
    dropoff: ST_PETE,
    max_delivery_fee: null,
  });
  const orderRef = actionHash(orderRecord);

  await dhtSync(both, customer.cells[0].cell_id[0]);

  const legRecord = await attestationOf(driver)<HcRecord>("record_leg", {
    order_ref: orderRef,
    sequence: 0,
    kind: "CustomerHandoff",
    to: customer.agentPubKey,
    geo_at_completion: ST_PETE,
  });
  const legRef = actionHash(legRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);

  // Root-caused the earlier "never finalizes" finding: a NON-enzymatic
  // session's finalization depends on some peer currently holding DHT-basis
  // authority over the entry hash to gather both signed actions and send
  // back a signature bundle -- on a fresh/tiny network that authority may
  // never resolve in time, so the session just times out. Setting
  // `enzymatic: true` (leg.from as the designated authority) makes both
  // parties push their signed action directly to that known peer instead,
  // sidestepping DHT-authority resolution entirely. This test is what
  // proves whether that actually fixes durability, not just trial-commit.
  const receiptRecord = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", legRef);
  const receiptRef = actionHash(receiptRecord);
  const receipt = decodeEntry<{ leg: Uint8Array; attested_at: number }>(receiptRecord);
  assert.ok(bytesEqual(receipt.leg, legRef), "driver's trial-committed receipt should reference the leg");
  console.log("[PASS] Preflight + trial commit succeeded with correct content");

  // With enzymatic sessions this now clears on the first attempt in
  // practice (near-instant) -- kept as a bounded retry rather than a single
  // call since chain-lock release is still an async conductor workflow, not
  // something the app should assume is synchronous with the commit call.
  await retryUntilOk(() => attestationOf(driver)("link_leg_to_receipt", { leg: legRef, receipt: receiptRef }));
  console.log("[PASS] Driver's chain unlocked and a separate write succeeded");

  const driverReceipts = await attestationOf(driver)<HcRecord[]>("list_my_receipts", null);

  // The authoritative check: query the customer's own source chain directly
  // (no DHT/link lookup involved at all) to confirm they actually hold the
  // countersigned entry on their own chain, not just that the initiator's
  // trial commit claimed success.
  const customerReceipts = await retryUntilOk(async () => {
    const receipts = await attestationOf(customer)<HcRecord[]>("list_my_receipts", null);
    assert.ok(receipts.length > 0, "customer's chain does not have the receipt yet");
    return receipts;
  });
  assert.equal(driverReceipts.length, 1, "the driver's own chain should hold exactly one countersigned receipt");
  assert.equal(customerReceipts.length, 1, "the customer's own chain should hold exactly one countersigned receipt");
  const customerReceipt = decodeEntry<{ leg: Uint8Array; attested_at: number }>(customerReceipts[0]);
  assert.ok(bytesEqual(customerReceipt.leg, legRef));
  assert.equal(customerReceipt.attested_at, receipt.attested_at, "both sides' committed entries should be byte-identical");
  console.log("[PASS] Countersigning proven durable and dual-sided: both independently-queried chains hold the identical receipt");
});
