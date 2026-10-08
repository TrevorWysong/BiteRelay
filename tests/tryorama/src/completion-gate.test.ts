// Proves the thing the user asked us to close: the leg-attestation
// completion gate used to be trusted from `complete_delivery` alone --
// nothing stopped a peer from calling `update_entry` directly (via their own
// custom coordinator wasm; coordinator zomes aren't part of a DNA's hash, so
// this is a real bypass path, not a hypothetical one) to skip it. It's now
// enforced by `dispatch_integrity::validate()` itself, which independently
// re-derives and checks `delivery_receipts` against the DHT. This test
// exercises `force_order_update_for_testing` -- a coordinator function that
// exists solely to simulate that bypass -- and confirms validate() still
// rejects a forged completion even when the honest coordinator checks are
// skipped entirely.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, ST_PETE, useTestCoordinators, acceptOrder } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, driver] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const both = [customer, driver];
  // force_order_update_for_testing only exists in the test-utils build.
  for (const player of both) await useTestCoordinators(player, ["dispatch"]);

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
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 600,
    dropoff: ST_PETE,
    max_delivery_fee: null,
  });
  const orderRef = actionHash(orderRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);
  await acceptOrder(customer, orderRef, both);

  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRef,
    eta_seconds: 900,
    price_offer: 400,
    collateral_commitment: { account: "stub", amount: 0, ledger_txn_ref: "pending" },
  });
  const bidRef = actionHash(bidRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);

  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
  await dispatchOf(customer)("set_order_status", { order_original_action: orderRef, next_status: "MerchantConfirmed" });
  await dhtSync(both, customer.cells[0].cell_id[0]);

  await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "DriverEnRouteToMerchant" });
  await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "PickedUp" });
  await dhtSync(both, customer.cells[0].cell_id[0]);

  // Attempt 1: no attestations at all -- an empty delivery_receipts list
  // covers zero required leg kinds.
  await assert.rejects(
    dispatchOf(customer)("force_order_update_for_testing", {
      order_original_action: orderRef,
      next_status: "Delivered",
      delivery_receipts: [],
    }),
    "an empty delivery_receipts must not satisfy the completion gate",
  );
  console.log("[PASS] validate() rejects a forged completion with zero attested legs");

  // Attempt 2: a real entry, but not a ReceiptAttestation -- validate()
  // must actually check the entry's type, not just its presence.
  await assert.rejects(
    dispatchOf(customer)("force_order_update_for_testing", {
      order_original_action: orderRef,
      next_status: "Delivered",
      delivery_receipts: [bidRef],
    }),
    "a delivery_receipts entry pointing at a Bid (not a ReceiptAttestation) must be rejected",
  );
  console.log("[PASS] validate() rejects a delivery_receipts entry of the wrong entry type");

  // Attempt 3: one genuinely attested leg, but only one of the two required
  // kinds -- proves the check is kind-aware, not just a length check.
  const legRecord = await attestationOf(driver)<HcRecord>("record_leg", {
    order_ref: orderRef,
    sequence: 0,
    kind: "MerchantHandoff",
    to: customer.agentPubKey,
    geo_at_completion: ST_PETE,
  });
  const legRef = actionHash(legRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);

  const receiptRecord = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", legRef);
  const receiptRef = actionHash(receiptRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);

  await assert.rejects(
    dispatchOf(customer)("force_order_update_for_testing", {
      order_original_action: orderRef,
      next_status: "Delivered",
      delivery_receipts: [receiptRef],
    }),
    /CustomerHandoff/,
    "one attested leg of only one required kind must not satisfy the completion gate",
  );
  console.log("[PASS] validate() rejects partial leg-kind coverage (MerchantHandoff attested, CustomerHandoff missing)");
});
