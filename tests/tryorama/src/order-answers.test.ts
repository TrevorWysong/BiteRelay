// Proves how a store answers an order, and what happens when it doesn't:
// every cancellation says why, and validation checks the reason against
// who gave it; a store set to auto-accept answers from its conductor
// (declining an order priced from an outdated menu); a scheduled order is
// placed with its store when due; and an order its store never answers is
// cancelled by the customer's conductor -- while the store's window to
// accept holds even with the customer offline. Runs with an 8-second
// window (the DNA's `store_response_secs`).
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, appWithProperties, decodeEntry, retryUntil, ST_PETE, useTestCoordinators } from "./helpers.js";

const WINDOW_SECS = 8;

interface OrderState {
  status: string;
  cancellation: string | { ByStore: string } | null;
}

await runScenario(async (scenario) => {
  const app = appWithProperties({ store_response_secs: WINDOW_SECS });
  const [customer, merchant] = await scenario.addPlayersWithApps([app, app]);
  const both = [customer, merchant];
  await scenario.shareAllAgents();
  // The customer can write what a modified client could.
  await useTestCoordinators(customer, ["dispatch"]);
  const sync = () => dhtSync(both, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);
  const pickupState = async (p: typeof customer, ref: Uint8Array) => decodeEntry<OrderState>(await call(p, "dispatch")<HcRecord>("get_pickup_order", ref));
  const deliveryState = async (ref: Uint8Array) => decodeEntry<OrderState>(await call(customer, "dispatch")<HcRecord>("get_order", ref));
  // The scheduler and gossip both take a moment: poll for up to a minute,
  // through reads that fail because a record hasn't arrived yet.
  const eventually = <T>(read: () => Promise<T>, done: (value: T) => boolean, attempts = 60) =>
    retryUntil(() => read().catch(() => undefined), (value): value is T => value !== undefined && done(value), attempts, 1000) as Promise<T>;

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const soup = { catalog_ref: store, name: "Soup", price_cents: 800, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [] };
  const soupRef = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", soup));
  await sync();
  const pickup = async (total = 800) => {
    const ref = actionHash(await call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: soupRef, quantity: 1 }], order_total: total }));
    await sync();
    return ref;
  };
  const forcePickup = (ref: Uint8Array, cancellation: unknown) =>
    call(customer, "dispatch")("force_pickup_update_for_testing", { order_original_action: ref, next_status: "Cancelled", cancellation });

  // --- Every cancellation says why, and only its author's reasons are accepted. ---
  const withdrawn = await pickup();
  await assert.rejects(call(merchant, "dispatch")("cancel_pickup_order", withdrawn), /ByCustomer isn't a cancellation this author can give/, "the store can't withdraw for the customer");
  await assert.rejects(
    call(customer, "dispatch")("decline_pickup_order", { order_original_action: withdrawn, reason: "TooBusy" }),
    /ByStore\(TooBusy\) isn't a cancellation this author can give/,
    "the customer can't decline for the store",
  );
  await assert.rejects(forcePickup(withdrawn, "StoreDidNotRespond"), /StoreDidNotRespond isn't a cancellation this author can give/, "nor claim the store didn't answer before its window passes");
  await assert.rejects(forcePickup(withdrawn, null), /cancelling an order must say why/);
  await call(customer, "dispatch")("cancel_pickup_order", withdrawn);
  const { status, cancellation } = await pickupState(customer, withdrawn);
  assert.deepEqual([status, cancellation], ["Cancelled", "ByCustomer"]);
  console.log("[PASS] a cancellation records why, and validation accepts only reasons its author can give");

  const declined = await pickup();
  await call(merchant, "dispatch")("decline_pickup_order", { order_original_action: declined, reason: "TooBusy" });
  await sync();
  assert.deepEqual((await pickupState(customer, declined)).cancellation, { ByStore: "TooBusy" });
  console.log("[PASS] the customer learns why the store declined");

  // --- An order the store never answers is cancelled by the customer's conductor. ---
  const unanswered = await pickup();
  const expired = await eventually(() => pickupState(customer, unanswered), (o) => o.status === "Cancelled");
  assert.equal(expired.cancellation, "StoreDidNotRespond");
  console.log("[PASS] the customer's conductor cancels an order its store didn't answer in time");

  // --- A store set to auto-accept answers from its conductor. ---
  await call(merchant, "catalog")("set_auto_accept_orders", { original_action: store, auto_accept_orders: true });
  await sync();
  const accepted = await pickup();
  assert.equal((await eventually(() => pickupState(customer, accepted), (o) => o.status !== "Placed")).status, "MerchantConfirmed");
  console.log("[PASS] an auto-accepting store's conductor accepts a pickup with nobody at the tablet");

  // A scheduled delivery is placed with the store when it's due -- and then
  // accepted, so it opens to drivers.
  const scheduled = actionHash(
    await call(customer, "dispatch")<HcRecord>("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: store,
      items: [{ item_ref: soupRef, quantity: 1 }],
      order_total: 800,
      dropoff: ST_PETE,
      max_delivery_fee: null,
      requested_delivery_time: Date.now() * 1000 + 3_000_000,
    }),
  );
  assert.equal((await deliveryState(scheduled)).status, "Scheduled");
  assert.equal((await eventually(() => deliveryState(scheduled), (o) => o.status === "Open")).status, "Open");
  console.log("[PASS] a scheduled delivery is placed with its store when due, and the store's conductor accepts it");

  // An order pinned to an old price is declined, with the reason.
  await call(merchant, "catalog")("update_menu_item", { original_action: soupRef, item: { ...soup, price_cents: 900 } });
  await sync();
  const pinned = actionHash(
    await call(customer, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: customer.agentPubKey,
      merchant: merchant.agentPubKey,
      catalog_ref: store,
      lines: [{ item_ref: soupRef, priced_version: soupRef, quantity: 1 }],
      order_total: 800,
      status: "Placed",
      dispute_ref: null,
      requested_at: Date.now() * 1000,
      kitchen_note: null,
      promo_code_ref: null,
      bag_claim_ref: null,
      loyalty_proof: [],
      cancellation: null,
    }),
  );
  await sync();
  // Nothing signals the store about a raw order -- its minute sweep finds it.
  const refused = await eventually(() => pickupState(customer, pinned), (o) => o.status !== "Placed", 120);
  assert.deepEqual(refused.cancellation, { ByStore: "OutdatedPrices" });
  console.log("[PASS] an auto-accepting store declines an order priced from an outdated menu, saying so");

  // --- The window binds the store even while the customer is offline. ---
  await call(merchant, "catalog")("set_auto_accept_orders", { original_action: store, auto_accept_orders: false });
  await sync();
  const late = await pickup(900);
  await customer.conductor.shutDown();
  await new Promise((resolve) => setTimeout(resolve, (WINDOW_SECS + 2) * 1000));
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: late }), /the store's window to accept this order has passed/);
  console.log("[PASS] past its window, the store can't accept an order -- whether or not the customer's conductor is there to cancel it");
});
