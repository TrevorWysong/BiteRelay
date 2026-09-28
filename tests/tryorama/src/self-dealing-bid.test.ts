// Regression test for a real bug hit manually: a single agent playing both
// requester/merchant and provider (the natural way to solo-test this app
// with one identity) could submit_bid + accept_bid on their own order, and
// the failure only surfaced much later, as a confusing `InvalidCommit` at
// pickup-confirmation time ("a leg's from and to must be different agents")
// -- `record_leg` correctly refused to create a Leg where from == to, but
// nothing earlier stopped the self-deal from being attempted at all.
// Fixed by rejecting it at the earliest point it's knowable: bid creation.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, driver] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const both = [customer, driver];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  // Customer doubles as the merchant, same convention as authorization.test.ts
  // -- exactly the shape that reproduces the real bug.
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 600, available: true });
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

  // The requester (who is also the merchant here) tries to bid on their own
  // order -- must be rejected, and rejected as a bid, not discovered later.
  await assert.rejects(
    dispatchOf(customer)("submit_bid", {
      order_ref: orderRef,
      eta_seconds: 600,
      price_offer: 400,
      collateral_commitment: { account: "stub", amount: 0, ledger_txn_ref: "pending" },
    }),
    /cannot bid to deliver their own order/,
    "a requester/merchant must not be able to bid to deliver their own order",
  );
  console.log("[PASS] validate() rejects a requester/merchant bidding on their own order");

  // A genuinely separate driver can still bid and win normally -- the guard
  // isn't overreaching into rejecting legitimate bids.
  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRef,
    eta_seconds: 600,
    price_offer: 400,
    collateral_commitment: { account: "stub", amount: 0, ledger_txn_ref: "pending" },
  });
  const bidRef = actionHash(bidRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
  console.log("[PASS] a genuinely separate driver can still bid and win normally");
});
