// Proves the rules that keep discounts honest: a goodie-bag claim pays for
// exactly one order (checked on-chain by walking the customer's own chain),
// a pickup order's promo code is validated like a delivery's, a bag can't
// be claimed once its window has closed, and a listed bag's terms can't be
// changed out from under the people claiming it.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, retryUntil, ST_PETE, useTestCoordinators, testApp } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await runScenario(async (scenario) => {
  const [merchant, customer] = await scenario.addPlayersWithApps([testApp, testApp]);
  const all = [merchant, customer];
  await scenario.shareAllAgents();
  // The customer can write what a modified client could.
  await useTestCoordinators(customer, ["dispatch"]);
  const sync = () => dhtSync(all, merchant.cells[0].cell_id[0]);
  const call = (p: typeof merchant, zome: string) => getZomeCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(merchant, "profiles")("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await call(customer, "profiles")("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  const storeA = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE }));
  const storeB = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's Tacos", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: storeA, name: "Burger", price_cents: 1000, available: true }));

  const bagInput = (fields: Record<string, unknown> = {}) => ({
    catalog_ref: storeA,
    title: "End-of-day bag",
    description: "",
    photo_data_uri: "",
    original_value_cents: 1500,
    price_cents: 500,
    quantity_total: 5,
    pickup_window_start: Date.now() * 1000,
    pickup_window_end: Date.now() * 1000 + 2 * 3600 * 1_000_000,
    supports_pickup: true,
    supports_delivery: false,
    created_at: Date.now() * 1000,
    ...fields,
  });
  const bag = actionHash(await call(merchant, "catalog")<HcRecord>("create_goodie_bag", bagInput()));
  await sync();

  // --- A confirmed claim redeems exactly one order. ---
  const claim = actionHash(await call(customer, "catalog")<HcRecord>("claim_goodie_bag", { bag_ref: bag, fulfillment: "Pickup" }));
  await sync();
  const confirmed = actionHash(await call(merchant, "catalog")<HcRecord>("confirm_claim", claim));
  await sync();
  // The customer's conductor redeems it by itself...
  const found = await retryUntil(() => call(customer, "dispatch")<Uint8Array | null>("get_my_order_for_claim", claim).catch(() => null), (order) => order !== null, 60, 1000);
  assert.ok(found, "get_my_order_for_claim should find the order redeeming the claim");
  // ...and validation refuses another, however the claim is cited.
  const redeemCiting = (cited: Uint8Array) =>
    call(customer, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: customer.agentPubKey,
      merchant: merchant.agentPubKey,
      catalog_ref: storeA,
      lines: [{ item_ref: bag, priced_version: bag, quantity: 1 }],
      order_total: 500,
      status: "Placed",
      requested_at: Date.now() * 1000,
      kitchen_note: null,
      promo_code_ref: null,
      bag_claim_ref: cited,
      loyalty_proof: [],
    });
  await assert.rejects(redeemCiting(confirmed), /already been redeemed/, "a second order on the same claim must be rejected by validation");
  await assert.rejects(redeemCiting(claim), /must be the store's confirmation of the claim/, "citing the claim as first made proves nothing");
  console.log("[PASS] a goodie-bag claim pays for exactly one order, however a client cites it");

  // --- Pickup orders validate their promo code, like deliveries do. ---
  const promoAt = async (store: Uint8Array, code: string, expiresAt: number | null) =>
    actionHash(await call(merchant, "catalog")<HcRecord>("create_promo_code", { catalog_ref: store, code, requirement: "None", reward: { PercentOffSubtotal: 10 }, expires_at: expiresAt, auto_apply: false }));
  const otherStorePromo = await promoAt(storeB, "TACOS10", null);
  const expiringPromo = await promoAt(storeA, "QUICK10", Date.now() * 1000 + 3_000_000);
  const retiredPromo = await promoAt(storeA, "OLD10", null);
  await call(merchant, "catalog")("set_promo_code_active", { original_action: retiredPromo, active: false });
  await sync();
  const pickupWithPromo = (promo: Uint8Array) =>
    call(customer, "dispatch")("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: storeA, items: [{ item_ref: item, quantity: 1 }], order_total: 900, promo_code_ref: promo });
  await assert.rejects(pickupWithPromo(otherStorePromo), /does not belong to this order's store/, "another store's code must be rejected");
  await assert.rejects(pickupWithPromo(retiredPromo), /not active/, "a deactivated code must be refused");
  await sleep(3500);
  await assert.rejects(pickupWithPromo(expiringPromo), /promo code has expired/, "an expired code must be rejected");
  console.log("[PASS] pickup orders reject another store's, deactivated and expired promo codes");

  // --- No claims once a bag's window has closed. ---
  const closingBag = actionHash(
    await call(merchant, "catalog")<HcRecord>("create_goodie_bag", bagInput({ pickup_window_start: Date.now() * 1000 - 60_000_000, pickup_window_end: Date.now() * 1000 + 2_000_000 })),
  );
  await sync();
  await sleep(2500);
  await assert.rejects(call(customer, "catalog")("claim_goodie_bag", { bag_ref: closingBag, fulfillment: "Pickup" }), /pickup window has closed/, "a claim after the window must be rejected");
  const listed = await call(customer, "catalog")<unknown[]>("list_goodie_bags_for_catalog", storeA);
  assert.equal(listed.length, 1, "a bag whose window has closed is no longer listed");
  console.log("[PASS] bags expire on-chain: no claims after the window, and they drop out of listings");

  // --- A listed bag's terms are fixed; only its presentation can change. ---
  await assert.rejects(
    call(merchant, "catalog")("create_goodie_bag", bagInput({ pickup_window_end: Date.now() * 1000 + 8 * 86_400 * 1_000_000 })),
    /within 7 days/,
    "a bag can't stay listed for more than a week",
  );
  const listing = bagInput();
  const termsBag = actionHash(await call(merchant, "catalog")<HcRecord>("create_goodie_bag", listing));
  await assert.rejects(
    call(merchant, "catalog")("update_goodie_bag", { original_action: termsBag, bag: { ...listing, price_cents: 100 } }),
    /may only change its title, description or photo/,
    "a bag's price can't change after listing",
  );
  await call(merchant, "catalog")("update_goodie_bag", { original_action: termsBag, bag: { ...listing, title: "Bigger bag tonight" } });
  console.log("[PASS] a bag's price, window and quantity are fixed once listed; its title can still change");
});
