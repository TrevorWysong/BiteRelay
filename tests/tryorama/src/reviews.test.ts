// Proves the reviews/ratings system (reputation zome's Review entry): a
// review targets a specific *store* or a specific *driver*, never a bare
// agent -- so one owner's two stores are rated independently, and an
// agent who both sells and drives never sees their store's stars on their
// driver rating (or vice versa). Also: only the order's real requester may
// review, only once the order is genuinely Delivered, only the store/driver
// actually on that order, at most once per target per order, and never a
// merchant rating their own store -- each enforced by validate() itself
// except the one-per-order rule (coordinator-level, see `submit_review`).
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, retryUntilOk, ST_PETE, acceptOrder, handOff } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const all = [customer, merchant, driver];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");
  const attestationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "attestation");
  const reputationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "reputation");
  type Summary = { count: number; rating_sum: number };
  type Page = { reviews: HcRecord[]; next_before: number | null };

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  // The merchant also drives -- the exact multi-role setup whose store
  // review used to show up on their driver dashboard.
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Requester", "Merchant", "Provider"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

  const storeA = actionHash(await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE }));
  const storeB = actionHash(await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Tacos", location: ST_PETE }));
  const itemA = actionHash(await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: storeA, name: "Cuban Sandwich", price_cents: 1250, available: true }));
  const itemB = actionHash(await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: storeB, name: "Al Pastor", price_cents: 900, available: true }));
  await sync();

  const orderRef = actionHash(
    await dispatchOf(customer)<HcRecord>("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: storeA,
      items: [{ item_ref: itemA, quantity: 1 }],
      order_total: 1250,
      dropoff: ST_PETE,
      max_delivery_fee: null,
    }),
  );
  await sync();
  await acceptOrder(merchant, orderRef, all);
  const bidRef = actionHash(
    await dispatchOf(driver)<HcRecord>("submit_bid", {
      order_ref: orderRef,
      eta_seconds: 900,
      price_offer: 400,
    }),
  );
  await sync();
  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
  await sync();

  // --- Negative: can't review before the order is Delivered. ---
  await assert.rejects(
    reputationOf(customer)("submit_review", { target: { Driver: driver.agentPubKey }, order_original_action: orderRef, rating: 5, comment: "too soon" }),
    /Delivered/,
    "a review must be rejected before the order reaches Delivered",
  );
  console.log("[PASS] validate() rejects a review submitted before the order is Delivered");

  // --- Negative: a non-requester can't review at all. ---
  await assert.rejects(
    reputationOf(driver)("submit_review", { target: { Driver: driver.agentPubKey }, order_original_action: orderRef, rating: 5, comment: "self-review" }),
    "a non-requester must not be able to submit a review",
  );
  console.log("[PASS] validate() rejects a review from anyone but the order's requester");

  // --- Drive the order to Delivered. ---
  await dispatchOf(merchant)("set_order_status", { order_original_action: orderRef, next_status: "MerchantConfirmed" });
  await sync();
  await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "DriverEnRouteToMerchant" });
  await sync();
  await handOff(driver, merchant, orderRef, "MerchantHandoff", all);
  await dispatchOf(driver)("pick_up_order", orderRef);
  await handOff(driver, customer, orderRef, "CustomerHandoff", all);
  await sync();
  await dispatchOf(customer)("complete_delivery", { order_original_action: orderRef });
  await sync();
  console.log("[PASS] Order driven to Delivered");

  // --- Negative: the target must actually be on this order. ---
  await assert.rejects(
    reputationOf(customer)("submit_review", { target: { Store: storeB }, order_original_action: orderRef, rating: 1, comment: "wrong store" }),
    /store this order was actually placed with/,
    "a review of the same owner's *other* store must be rejected",
  );
  await assert.rejects(
    reputationOf(customer)("submit_review", { target: { Driver: merchant.agentPubKey }, order_original_action: orderRef, rating: 1, comment: "not my driver" }),
    /accepted driver/,
    "a driver review naming anyone but the accepted driver must be rejected",
  );
  console.log("[PASS] validate() rejects a review aimed at a store or driver that wasn't on the order");

  // --- Positive: one store review, one driver review. ---
  const driverReview = decodeEntry<{ target: { Driver: Uint8Array }; rating: number; comment: string }>(
    await reputationOf(customer)<HcRecord>("submit_review", { target: { Driver: driver.agentPubKey }, order_original_action: orderRef, rating: 5, comment: "Fast and friendly!" }),
  );
  assert.equal(driverReview.rating, 5);
  assert.equal(driverReview.comment, "Fast and friendly!");
  await reputationOf(customer)("submit_review", { target: { Store: storeA }, order_original_action: orderRef, rating: 4, comment: "Great sandwich" });
  console.log("[PASS] submit_review succeeds for the order's own store and its accepted driver");

  // --- Negative: one review per target per order. ---
  await assert.rejects(
    reputationOf(customer)("submit_review", { target: { Store: storeA }, order_original_action: orderRef, rating: 1, comment: "second try" }),
    /already rated/,
    "a second review of the same store for the same order must be refused",
  );
  const mine = await reputationOf(customer)<HcRecord[]>("get_my_reviews_for_order", orderRef);
  assert.equal(mine.length, 2, "get_my_reviews_for_order should report both reviews just left");
  console.log("[PASS] a second review of the same target on the same order is refused, and get_my_reviews_for_order reports both");

  await sync();

  // --- The point of scoping: every target only sees its own reviews. ---
  const storeASummary = await retryUntilOk(async () => {
    const s = await reputationOf(merchant)<Summary>("get_rating_summary", { Store: storeA });
    assert.equal(s.count, 1);
    return s;
  });
  assert.equal(storeASummary.rating_sum, 4);
  assert.deepEqual(await reputationOf(merchant)<Summary>("get_rating_summary", { Store: storeB }), { count: 0, rating_sum: 0 }, "store B must not inherit store A's rating");
  assert.deepEqual(
    await reputationOf(merchant)<Summary>("get_rating_summary", { Driver: merchant.agentPubKey }),
    { count: 0, rating_sum: 0 },
    "the merchant's own driver rating must not include their store's review",
  );
  assert.deepEqual(await reputationOf(driver)<Summary>("get_rating_summary", { Driver: driver.agentPubKey }), { count: 1, rating_sum: 5 });
  console.log("[PASS] get_rating_summary is scoped: store A 4★ (1), store B none, the merchant-as-driver none, the driver 5★ (1)");

  const driverPage = await reputationOf(driver)<Page>("get_reviews_for", { target: { Driver: driver.agentPubKey }, before: null });
  assert.equal(driverPage.reviews.length, 1);
  assert.equal(driverPage.next_before, null);
  const storePage = await reputationOf(merchant)<Page>("get_reviews_for", { target: { Store: storeA }, before: null });
  assert.equal(decodeEntry<{ comment: string }>(storePage.reviews[0]).comment, "Great sandwich");
  assert.equal((await reputationOf(merchant)<Page>("get_reviews_for", { target: { Driver: merchant.agentPubKey }, before: null })).reviews.length, 0);
  console.log("[PASS] get_reviews_for returns only the requested target's reviews");

  // Reputation events are scoped the same way: the delivery counts once
  // toward the driver and once toward store A -- never toward store B or
  // the merchant's own driving.
  type Rep = { completed_count: number };
  await retryUntilOk(async () => {
    assert.equal((await reputationOf(driver)<Rep>("get_reputation_summary", { Driver: driver.agentPubKey })).completed_count, 1);
    assert.equal((await reputationOf(merchant)<Rep>("get_reputation_summary", { Store: storeA })).completed_count, 1);
  });
  assert.equal((await reputationOf(merchant)<Rep>("get_reputation_summary", { Store: storeB })).completed_count, 0);
  assert.equal((await reputationOf(merchant)<Rep>("get_reputation_summary", { Driver: merchant.agentPubKey })).completed_count, 0);
  console.log("[PASS] completion reputation counts toward the driver and the order's own store only");

  // --- Negative: a merchant can't rate their own store, even via a real self-order. ---
  const selfOrder = actionHash(
    await dispatchOf(merchant)<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: storeB, items: [{ item_ref: itemB, quantity: 1 }], order_total: 900 }),
  );
  await dispatchOf(merchant)("accept_pickup_order", { order_original_action: selfOrder });
  await dispatchOf(merchant)("mark_ready_for_pickup", selfOrder);
  await dispatchOf(merchant)("complete_pickup", selfOrder);
  await assert.rejects(
    reputationOf(merchant)("submit_review", { target: { Store: storeB }, order_original_action: selfOrder, rating: 5, comment: "best tacos ever" }),
    /cannot review their own store/,
    "a merchant reviewing their own store must be rejected",
  );
  console.log("[PASS] validate() rejects a merchant reviewing their own store");
});
