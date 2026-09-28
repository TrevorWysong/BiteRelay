// Contested warrants (architecture plan §11.2). Verifies check_warrants
// against the real get_agent_activity API end to end, and that accept_bid's
// warrant gate does not spuriously misfire on a clean agent.
//
// What this test deliberately does NOT do, and why: the plan originally
// called for triggering a *genuine* warrant (via the same bypass-coordinator
// pattern dispute-bypass.test.ts uses) and confirming check_warrants sees
// it. Empirically probing that first (see the architecture plan's §11.2
// follow-up) found it doesn't work -- a stock, unmodified conductor runs the
// exact same deterministic validate() at self-commit time (before anything
// is ever published to the DHT) that a remote authority would run on
// receipt, so a bypass attempt is rejected locally and never reaches any
// other validator to be warranted against. A genuine ChainFork warrant would
// need the same agent's private key material live on two independent
// conductor processes authoring divergent chains concurrently -- not
// achievable here either, since `generateAgentPubKey` takes no seed and
// there is no key-import admin call, so two conductors can never end up
// holding the same keypair. Both of those are real architectural/API
// boundaries, not gaps in this test harness's cleverness -- see the plan's
// note for why forcing a fake positive here would be worse than an honestly
// narrower test.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, setupArbitratedPlayers, ST_PETE } from "./helpers.js";

type WarrantSummary = { count: number; has_chain_fork: boolean; has_invalid_chain_op: boolean };

await runScenario(async (scenario) => {
  const { customer, driver, arbitrator, all } = await setupArbitratedPlayers(scenario);

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // A real get_agent_activity call, end to end, against a clean agent with
  // real chain history (genesis actions + a create_profile) -- proves the
  // API round-trips correctly in this hdk/holochain version and that the
  // decode/summarization logic doesn't error, rather than merely compiling.
  const cleanSummary = await dispatchOf(arbitrator)<WarrantSummary>("check_warrants", driver.agentPubKey);
  assert.deepEqual(cleanSummary, { count: 0, has_chain_fork: false, has_invalid_chain_op: false }, "a clean agent must show zero warrants");
  console.log("[PASS] check_warrants against a real, clean agent chain correctly reports zero warrants");

  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 600, available: true });
  const menuItemRef = actionHash(menuItemRecord);

  const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: customer.agentPubKey, catalog_ref: catalogRef, item_refs: [menuItemRef],
    order_total: 600, dropoff: ST_PETE, max_delivery_fee: null,
  });
  const orderRef = actionHash(orderRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRef, eta_seconds: 900, price_offer: 400,
    collateral_commitment: { account: "stub", amount: 100, ledger_txn_ref: "pending" },
  });
  const bidRef = actionHash(bidRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // Default path (override_warrants omitted -> false): a clean bidder is
  // accepted normally -- the gate must not misfire on the common case.
  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
  console.log("[PASS] accept_bid succeeds by default against a bidder with zero warrants");

  // Explicit override_warrants: true must also succeed cleanly (a no-op
  // here since there's nothing to override, but proves the field wires
  // through end to end without breaking the accept path).
  const orderRecord2 = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: customer.agentPubKey, catalog_ref: catalogRef, item_refs: [menuItemRef],
    order_total: 600, dropoff: ST_PETE, max_delivery_fee: null,
  });
  const orderRef2 = actionHash(orderRecord2);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const bidRecord2 = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRef2, eta_seconds: 900, price_offer: 400,
    collateral_commitment: { account: "stub", amount: 100, ledger_txn_ref: "pending" },
  });
  const bidRef2 = actionHash(bidRecord2);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef2, bid_action: bidRef2, override_warrants: true });
  console.log("[PASS] accept_bid with override_warrants: true also succeeds cleanly");
});
