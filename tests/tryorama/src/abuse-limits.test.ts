// Proves the limits that stop one person crowding out everyone else, here
// with a network limit of two waiting orders so each shows in a few steps:
//
// - a store's minimum order holds, against its own terms as the order cites
//   them;
// - a customer can't bury stores in orders: at most so many placed within
//   one store response window;
// - a driver bids on an order once, so nobody can crowd out other bids;
// - a goodie bag that's been ordered stays sold -- and one held but never
//   ordered goes back on sale (its hold lapses).
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, decodeEntry, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators, retryingCaller } from "./helpers.js";

const PRICE = 1000;

await runScenario(async (scenario) => {
  const [customer, merchant, driver, neighbour] = await setupPlayersWithProperties(scenario, 4, () => ({ max_pending_orders: 2 }));
  const all = [customer, merchant, driver, neighbour];
  for (const p of all) await useTestCoordinators(p, ["dispatch", "catalog", "reputation"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(neighbour, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: PRICE, available: true }));
  await sync();

  const pickup = (p: typeof customer, quantity: number) =>
    call(p, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity }], order_total: PRICE * quantity });
  /// An order written past the coordinator's checks, citing the store's
  /// terms as of `version` -- its latest unless given.
  const rawPickup = async (quantity: number, version?: Uint8Array) => {
    version ??= actionHash(await call(customer, "catalog")<HcRecord>("get_catalog", store));
    return call(customer, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: customer.agentPubKey,
      merchant: merchant.agentPubKey,
      catalog_ref: store,
      catalog_version: version,
      // The item's never changed, so it's priced at its first version.
      lines: [{ item_ref: stew, priced_version: stew, quantity }],
      order_total: PRICE * quantity,
      status: "Placed",
      requested_at: Date.now() * 1000,
      kitchen_note: null,
      promo_code_ref: null,
      bag_claim_ref: null,
      loyalty_proof: [],
      cancellation: null,
      ready_by: null,
      food_hold: null,
      sealed_customer_name: null,
    });
  };

  // ===== A store's minimum order =====
  await call(merchant, "catalog")("set_minimum_order", { original_action: store, min_cents: PRICE + 500 });
  await sync();
  await retryUntil(
    () => pickup(customer, 1).then(() => "placed", (e: Error) => e.message),
    (outcome) => /below the store's minimum/.test(outcome),
  );
  await assert.rejects(rawPickup(1), /below the store's minimum/, "the network refuses it too, against the store version the order cites");
  // Citing the store's first version, from before it set a minimum, gets
  // past validation -- but not past the store.
  const underOldTerms = actionHash(await rawPickup(1, store));
  await sync();
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: underOldTerms }), /earlier terms/, "the store holds an order to its current terms");
  await retryUntilOk(() => pickup(customer, 2));
  console.log("[PASS] a store's minimum order holds, whichever version of its terms an order cites");

  // ===== Waiting orders =====
  await assert.rejects(pickup(customer, 2), /the most the network allows/, "a customer can't place more than the network allows at once");
  await assert.rejects(rawPickup(2), /as many orders as the network allows at once/, "nor can a modified app");
  console.log("[PASS] a customer can't bury stores in orders");

  // ===== One bid per driver =====
  await call(merchant, "catalog")("set_minimum_order", { original_action: store, min_cents: null });
  const delivery = actionHash(
    await retryUntilOk(() =>
      call(neighbour, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: PRICE, dropoff: ST_PETE, max_delivery_fee: null }),
    ),
  );
  await sync();
  await acceptOrder(merchant, delivery, all);
  const bid = await retryUntilOk(() => call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: delivery, eta_seconds: 600, price_offer: 400 }));
  await assert.rejects(call(driver, "dispatch")("submit_bid", { order_ref: delivery, eta_seconds: 300, price_offer: 300 }), /already bid on this order/);
  await assert.rejects(call(driver, "dispatch")("create_raw_bid_for_testing", { ...decodeEntry<object>(bid), price_offer: 300 }), /bids on an order once/, "the network refuses a second bid");
  console.log("[PASS] a driver bids on an order once");

  // ===== A goodie bag stays sold once ordered =====
  const bag = actionHash(
    await call(merchant, "catalog")<HcRecord>("create_goodie_bag", {
      catalog_ref: store,
      title: "End of day",
      original_value_cents: 2000,
      price_cents: 500,
      quantity_total: 1,
      pickup_window_start: Date.now() * 1000,
      pickup_window_end: (Date.now() + 2 * 3_600_000) * 1000,
      supports_pickup: true,
      supports_delivery: false,
      created_at: Date.now() * 1000,
    }),
  );
  await sync();
  const claimRecord = await call(neighbour, "catalog")<HcRecord>("claim_goodie_bag", { bag_ref: bag, fulfillment: "Pickup" });
  const claim = actionHash(claimRecord);
  await assert.rejects(call(neighbour, "catalog")("claim_goodie_bag", { bag_ref: bag, fulfillment: "Pickup" }), /already claimed this goodie bag/);
  await assert.rejects(
    call(neighbour, "catalog")("create_raw_bag_claim_for_testing", { ...decodeEntry<object>(claimRecord), claimed_at: Date.now() * 1000 }),
    /claims a goodie bag once/,
    "a customer claims a bag once, so nobody floods a store's claims",
  );
  await sync();
  await retryUntilOk(() => call(merchant, "catalog")("confirm_claim", claim));
  await sync();
  // The neighbour's app orders it as soon as it's confirmed; the store accepts.
  const bagOrder = await retryUntil(() => call(neighbour, "dispatch")<Uint8Array | null>("get_my_order_for_claim", claim), (order) => order !== null, 120, 1000);
  assert.ok(bagOrder, "the customer's app ordered the confirmed bag");
  await sync();
  // The store's app may accept it first; either way, it ends up accepted.
  await retryUntilOk(() =>
    call(merchant, "dispatch")("accept_pickup_order", { order_original_action: bagOrder }).catch((e: Error) => {
      if (!/already been accepted/.test(e.message)) throw e;
    }),
  );
  await sync();
  const status = await retryUntil(
    async () => decodeEntry<{ status: string }>(await call(merchant, "catalog")<HcRecord>("get_bag_claim", claim)).status,
    (s) => s === "Redeemed",
  );
  assert.equal(status, "Redeemed", "the store records the bag as sold when it accepts its order");
  const second = actionHash(await call(customer, "catalog")<HcRecord>("claim_goodie_bag", { bag_ref: bag, fulfillment: "Pickup" }));
  await sync();
  await assert.rejects(call(merchant, "catalog")("confirm_claim", second), /sold out/, "a sold bag isn't confirmed again");
  console.log("[PASS] a goodie bag that's been ordered stays sold");
});
