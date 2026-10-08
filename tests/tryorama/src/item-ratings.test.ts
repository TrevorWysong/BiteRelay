// Proves per-item ratings (reputation zome): a review against an item
// genuinely in the delivered order succeeds and is reflected in
// get_item_rating_summary; a review against an item that was never part
// of that order is rejected; a review before the order is Delivered is
// rejected; the summary's average is correct across multiple reviews.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, retryUntilOk, ST_PETE, acceptOrder } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const all = [customer, merchant, driver];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");
  const attestationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "attestation");
  const reputationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "reputation");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const burgerRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Burger", price_cents: 800, available: true });
  const burgerRef = actionHash(burgerRecord);
  const friesRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Fries", price_cents: 300, available: true });
  const friesRef = actionHash(friesRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // Order includes only the burger -- fries are a real menu item, just
  // never part of *this* order.
  const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: merchant.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: burgerRef, quantity: 1 }],
    order_total: 800,
    dropoff: ST_PETE,
    max_delivery_fee: null,
  });
  const orderRef = actionHash(orderRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await acceptOrder(merchant, orderRef, all);

  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRef,
    eta_seconds: 600,
    price_offer: 400,
    collateral_commitment: { account: "stub", amount: 0, ledger_txn_ref: "pending" },
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: actionHash(bidRecord) });

  // Before Delivered -- rejected.
  await assert.rejects(
    reputationOf(customer)("submit_item_review", { item_ref: burgerRef, order_original_action: orderRef, rating: 5, comment: "great" }),
    /an item can only be reviewed against a Delivered order/,
    "an item review before the order is Delivered must be rejected",
  );
  console.log("[PASS] an item review before Delivered is rejected");

  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(merchant)("set_order_status", { order_original_action: orderRef, next_status: "MerchantConfirmed" });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "DriverEnRouteToMerchant" });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const merchantLegRecord = await attestationOf(driver)<HcRecord>("record_leg", { order_ref: orderRef, sequence: 0, kind: "MerchantHandoff", to: merchant.agentPubKey, geo_at_completion: ST_PETE });
  const merchantLegRef = actionHash(merchantLegRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const merchantReceiptRecord = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", merchantLegRef);
  await retryUntilOk(() => attestationOf(driver)("link_leg_to_receipt", { leg: merchantLegRef, receipt: actionHash(merchantReceiptRecord) }));

  await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "PickedUp" });
  const customerLegRecord = await attestationOf(driver)<HcRecord>("record_leg", { order_ref: orderRef, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE });
  const customerLegRef = actionHash(customerLegRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const customerReceiptRecord = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", customerLegRef);
  await retryUntilOk(() => attestationOf(driver)("link_leg_to_receipt", { leg: customerLegRef, receipt: actionHash(customerReceiptRecord) }));
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("complete_delivery", { order_original_action: orderRef });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // Fries were never ordered -- rejected even though they're a real item.
  await assert.rejects(
    reputationOf(customer)("submit_item_review", { item_ref: friesRef, order_original_action: orderRef, rating: 5, comment: "never had these" }),
    /item_ref must have actually been part of the reviewed order/,
    "reviewing an item never part of the order must be rejected",
  );
  console.log("[PASS] reviewing an item that was never part of the order is rejected");

  await reputationOf(customer)("submit_item_review", { item_ref: burgerRef, order_original_action: orderRef, rating: 5, comment: "excellent" });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  let summary = await reputationOf(merchant)<{ count: number; rating_sum: number }>("get_item_rating_summary", burgerRef);
  assert.equal(summary.count, 1);
  assert.equal(summary.rating_sum, 5);
  console.log("[PASS] a valid item review is reflected in get_item_rating_summary");

  // A second order + review to prove the average is a real fold across
  // multiple reviews, not just echoing the one.
  const order2Record = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: merchant.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: burgerRef, quantity: 1 }],
    order_total: 800,
    dropoff: ST_PETE,
    max_delivery_fee: null,
  });
  const order2Ref = actionHash(order2Record);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await acceptOrder(merchant, order2Ref, all);
  const bid2Record = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: order2Ref,
    eta_seconds: 600,
    price_offer: 400,
    collateral_commitment: { account: "stub", amount: 0, ledger_txn_ref: "pending" },
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("accept_bid", { order_original_action: order2Ref, bid_action: actionHash(bid2Record) });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(merchant)("set_order_status", { order_original_action: order2Ref, next_status: "MerchantConfirmed" });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(driver)("set_order_status", { order_original_action: order2Ref, next_status: "DriverEnRouteToMerchant" });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const leg2aRecord = await attestationOf(driver)<HcRecord>("record_leg", { order_ref: order2Ref, sequence: 0, kind: "MerchantHandoff", to: merchant.agentPubKey, geo_at_completion: ST_PETE });
  const leg2aRef = actionHash(leg2aRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const receipt2a = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", leg2aRef);
  await retryUntilOk(() => attestationOf(driver)("link_leg_to_receipt", { leg: leg2aRef, receipt: actionHash(receipt2a) }));

  await dispatchOf(driver)("set_order_status", { order_original_action: order2Ref, next_status: "PickedUp" });
  const leg2bRecord = await attestationOf(driver)<HcRecord>("record_leg", { order_ref: order2Ref, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE });
  const leg2bRef = actionHash(leg2bRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const receipt2b = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", leg2bRef);
  await retryUntilOk(() => attestationOf(driver)("link_leg_to_receipt", { leg: leg2bRef, receipt: actionHash(receipt2b) }));
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("complete_delivery", { order_original_action: order2Ref });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await reputationOf(customer)("submit_item_review", { item_ref: burgerRef, order_original_action: order2Ref, rating: 3, comment: "just okay this time" });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  summary = await reputationOf(merchant)<{ count: number; rating_sum: number }>("get_item_rating_summary", burgerRef);
  assert.equal(summary.count, 2, "both reviews should be counted");
  assert.equal(summary.rating_sum, 8, "the sum should be 5 + 3");
  console.log("[PASS] get_item_rating_summary correctly folds multiple reviews (avg = 8/2 = 4.0)");

  const { reviews } = await reputationOf(customer)<{ reviews: HcRecord[] }>("get_item_reviews", { item_ref: burgerRef, before: null });
  assert.equal(reviews.length, 2, "get_item_reviews should return both individual reviews");
  console.log("[PASS] get_item_reviews returns the individual reviews, not just the summary");
});
