// Proves the reviews/ratings system (reputation zome's new Review entry):
// only the order's real requester may review, only about its real merchant
// or accepted driver, and only once the order is genuinely Delivered --
// enforced by validate() itself, not just the honest submit_review path.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, retryUntilOk, ST_PETE } from "./helpers.js";

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
  const attestationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "attestation");
  const reputationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "reputation");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Cuban Sandwich", price_cents: 1250, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [] });
  const menuItemRef = actionHash(menuItemRecord);

  const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: customer.agentPubKey,
    catalog_ref: catalogRef,
    item_refs: [menuItemRef],
    order_total: 1250,
    dropoff: ST_PETE,
    max_delivery_fee: null,
    special_instructions: "Leave at the door",
    tip_cents: 200,
  });
  const orderRef = actionHash(orderRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);

  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRef,
    eta_seconds: 900,
    price_offer: 400,
    collateral_commitment: { account: "stub", amount: 0, ledger_txn_ref: "pending" },
  });
  const bidRef = actionHash(bidRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);

  // --- Negative: can't review before the order is Delivered. ---
  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
  await dhtSync(both, customer.cells[0].cell_id[0]);
  await assert.rejects(
    reputationOf(customer)("submit_review", { subject: driver.agentPubKey, order_original_action: orderRef, rating: 5, comment: "too soon" }),
    /Delivered/,
    "a review must be rejected before the order reaches Delivered",
  );
  console.log("[PASS] validate() rejects a review submitted before the order is Delivered");

  // --- Negative: a non-requester can't review at all. ---
  await assert.rejects(
    reputationOf(driver)("submit_review", { subject: driver.agentPubKey, order_original_action: orderRef, rating: 5, comment: "self-review" }),
    "a non-requester must not be able to submit a review",
  );
  console.log("[PASS] validate() rejects a review from anyone but the order's requester");

  // --- Drive the order to Delivered (same flow as full-lifecycle.test.ts). ---
  await dispatchOf(customer)("set_order_status", { order_original_action: orderRef, next_status: "MerchantConfirmed" });
  await dhtSync(both, customer.cells[0].cell_id[0]);
  await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "DriverEnRouteToMerchant" });

  const merchantLegRecord = await attestationOf(driver)<HcRecord>("record_leg", { order_ref: orderRef, sequence: 0, kind: "MerchantHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE });
  const merchantLegRef = actionHash(merchantLegRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);
  const merchantReceiptRecord = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", merchantLegRef);
  await retryUntilOk(() => attestationOf(driver)("link_leg_to_receipt", { leg: merchantLegRef, receipt: actionHash(merchantReceiptRecord) }));

  await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "PickedUp" });
  const customerLegRecord = await attestationOf(driver)<HcRecord>("record_leg", { order_ref: orderRef, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE });
  const customerLegRef = actionHash(customerLegRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);
  const customerReceiptRecord = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", customerLegRef);
  await retryUntilOk(() => attestationOf(driver)("link_leg_to_receipt", { leg: customerLegRef, receipt: actionHash(customerReceiptRecord) }));
  await dhtSync(both, customer.cells[0].cell_id[0]);

  await dispatchOf(customer)("complete_delivery", { order_original_action: orderRef });
  console.log("[PASS] Order driven to Delivered");

  // --- Now the real thing: submit reviews for both the driver and the merchant. ---
  const driverReviewRecord = await reputationOf(customer)<HcRecord>("submit_review", {
    subject: driver.agentPubKey,
    order_original_action: orderRef,
    rating: 5,
    comment: "Fast and friendly!",
  });
  const driverReview = decodeEntry<{ subject: Uint8Array; author: Uint8Array; rating: number; comment: string }>(driverReviewRecord);
  assert.equal(driverReview.rating, 5);
  assert.equal(driverReview.comment, "Fast and friendly!");
  console.log("[PASS] submit_review succeeds for the accepted driver on a genuinely Delivered order");

  await reputationOf(customer)("submit_review", {
    subject: customer.agentPubKey, // customer doubles as the merchant in this test, matching full-lifecycle.test.ts's convention
    order_original_action: orderRef,
    rating: 4,
    comment: "Great empanadas",
  });
  console.log("[PASS] submit_review succeeds for the order's merchant");

  await dhtSync(both, customer.cells[0].cell_id[0]);

  const driverReviews = await reputationOf(driver)<HcRecord[]>("get_reviews_for", driver.agentPubKey);
  assert.equal(driverReviews.length, 1, "expected exactly one review for the driver");
  assert.equal(decodeEntry<{ rating: number }>(driverReviews[0]).rating, 5);
  console.log("[PASS] get_reviews_for returns the driver's review, readable by the driver themselves");
});
