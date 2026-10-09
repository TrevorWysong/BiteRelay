// Proves "it never arrived" can be answered: a delivery PIN that only the
// customer can give, required where the store says so; a delivery the
// customer neither confirms nor disputes going to the arbitrators with the
// driver's evidence; an arbitrator's conductor ruling the clear cases on its
// own (a matching PIN; an unconfirmed, photographed drop-off) and leaving the
// rest (a wrong PIN) for a person; and a customer who's lost a dispute
// being asked for their PIN next time.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, closeIssueWindow, decodeEntry, handOff, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE } from "./helpers.js";

const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

interface Order {
  status: string;
  pin_commitment: Uint8Array;
  pin_for_arbitrators: unknown[];
  pin_required: boolean;
}

await runScenario(async (scenario) => {
  const [customer, merchant, driver, arbitrator] = await setupPlayersWithProperties(scenario, 4, (keys) => ({ arbitrators: [keys[3]], confirm_window_secs: 5, issue_window_secs: 3 }));
  const all = [customer, merchant, driver, arbitrator];
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);
  const order = async (ref: Uint8Array) => decodeEntry<Order>(await call(customer, "dispatch")<HcRecord>("get_order", ref));
  const balance = (p: typeof customer, expected: number) => retryUntil(() => call(p, "ledger")<number>("get_balance", p.agentPubKey), (b) => b === expected, 120, 1000);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 1000, available: true }));
  await sync();

  /// A delivery picked up by the driver, as far as the door.
  async function toTheDoor() {
    const ref = actionHash(
      await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity: 1 }], order_total: 1000, dropoff: ST_PETE, max_delivery_fee: null })),
    );
    await sync();
    await acceptOrder(merchant, ref, all);
    const bid = actionHash(await retryUntilOk(() => call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: ref, eta_seconds: 600, price_offer: 400 })));
    await sync();
    await retryUntilOk(() => call(customer, "dispatch")("accept_bid", { order_original_action: ref, bid_action: bid }));
    await sync();
    await retryUntilOk(() => call(merchant, "dispatch")("set_order_status", { order_original_action: ref, next_status: "MerchantConfirmed" }));
    await sync();
    await call(driver, "dispatch")("set_order_status", { order_original_action: ref, next_status: "DriverEnRouteToMerchant" });
    await handOff(driver, merchant, ref, "MerchantHandoff", all);
    await call(driver, "dispatch")("pick_up_order", ref);
    await sync();
    return ref;
  }
  const dropOff = (ref: Uint8Array, extra: { pin?: string; photo_data_uri?: string }) =>
    call(driver, "attestation")("record_leg", { order_ref: ref, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE, ...extra });
  /// The driver's conductor escalating it once the window's passed, and the
  /// arbitrator's conductor reviewing.
  async function escalateAndReview() {
    await sync();
    await retryUntil(() => call(driver, "dispatch")<number>("escalate_unconfirmed", null), (n) => n > 0, 40, 1000);
    await sync();
    return call(arbitrator, "dispatch")<number>("arbitrate", null);
  }

  // --- No PIN asked of a customer with no history -- but a photo: an
  // unconfirmed, undisputed drop-off is the provider's. ---
  const photographed = await toTheDoor();
  const first = await order(photographed);
  assert.equal(first.pin_commitment.length, 32, "every delivery commits to a PIN");
  assert.equal(first.pin_for_arbitrators.length, 1, "sealed to each arbitrator");
  assert.equal(first.pin_required, false, "a store asks for it only after a lost dispute (the default), and this customer has none");
  await dropOff(photographed, { photo_data_uri: PHOTO });
  assert.equal(await escalateAndReview(), 1, "the arbitrator's conductor rules an unconfirmed, photographed drop-off on its own");
  await sync();
  assert.equal((await order(photographed)).status, "Delivered");
  assert.equal(await balance(driver, 400), 400, "the driver is paid the whole fee and has their collateral back");
  await closeIssueWindow(arbitrator, merchant, photographed, all);
  assert.equal(await balance(merchant, 1000 - 200), 1000 - 200, "the store is paid for the food once its issue window closes");
  console.log("[PASS] an unconfirmed drop-off with the driver's photo, never disputed, is ruled for the provider");

  // --- That customer has now lost a dispute, so the store asks for their PIN. ---
  await retryUntil(
    () => call(merchant, "reputation")<{ dispute_resolved_against_count: number }>("get_reputation_summary", { Customer: customer.agentPubKey }),
    (summary) => summary.dispute_resolved_against_count > 0,
    40,
    1000,
  );
  const withPin = await toTheDoor();
  assert.equal((await order(withPin)).pin_required, true, "a customer who's lost a dispute is asked for their PIN");
  await assert.rejects(dropOff(withPin, {}), /requires the customer's PIN/, "a drop-off can't be recorded without it");
  const pin = await call(customer, "dispatch")<string | null>("get_my_delivery_pin", withPin);
  assert.match(pin ?? "", /^\d{6}$/, "the customer's app shows their PIN");
  assert.equal(await call(driver, "dispatch")("get_my_delivery_pin", withPin), null, "nobody else can read it");
  await dropOff(withPin, { pin: pin! });
  console.log("[PASS] a customer who's lost a dispute must give their PIN, which only they can read");

  // They never confirm; the PIN settles it.
  assert.equal(await escalateAndReview(), 1, "the arbitrator's conductor rules a matching PIN on its own");
  await sync();
  assert.equal((await order(withPin)).status, "Delivered");
  assert.equal(await balance(driver, 800), 800, "the driver is paid");
  await closeIssueWindow(arbitrator, merchant, withPin, all);
  assert.equal(await balance(merchant, 2 * (1000 - 200)), 2 * (1000 - 200), "and the store, after the window");
  console.log("[PASS] an unconfirmed delivery with the customer's PIN is ruled for the provider, automatically");

  // --- A store requiring the PIN always; a wrong one is left for a person. ---
  await call(merchant, "catalog")("set_pin_policy", { original_action: store, pin_policy: "Always" });
  await sync();
  const wrongPin = await toTheDoor();
  assert.equal((await order(wrongPin)).pin_required, true);
  const realPin = await call(customer, "dispatch")<string>("get_my_delivery_pin", wrongPin);
  await dropOff(wrongPin, { pin: realPin === "000000" ? "111111" : "000000" });
  assert.equal(await escalateAndReview(), 0, "nothing clear to rule on");
  assert.equal(await call(arbitrator, "dispatch")("check_delivery_pin", wrongPin), "Mismatch", "the review screen shows the PINs don't match");
  assert.equal((await order(wrongPin)).status, "Disputed", "it waits for a person");
  console.log("[PASS] a wrong PIN is left for an arbitrator to decide");
});
