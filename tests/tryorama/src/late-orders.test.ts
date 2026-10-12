// Proves who pays when a driver leaves an order or a store runs late --
// what DoorDash smooths over from the middle, done here by the order's own
// parties, with a customer never paying for food they didn't get unless
// they chose to:
//
// - hot potato: a driver who leaves an order the store started cooking
//   answers for its food until another driver takes it on -- then they're
//   clear;
// - a store that keeps a checked-in driver waiting past its own wait is
//   called late -- proved against the public time source: the driver leaves
//   paid in full by the store, the order reopens to another driver, and its
//   customer may cancel for a full refund;
// - only a driver or the store moves a driver on, the store only once
//   they're late, and a driver only with proof of the time.
//
// No driver coming at all, and the customer collecting it themselves, are
// `no-driver.test.ts`.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, commitAndCook, currentBeacon, deliveryStatus, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators } from "./helpers.js";

const FOOD = 1000;
const FEE = 400;
/// The store covers half the fee (the network's default).
const STORE_SHARE = FEE / 2;
/// The shortest prep a store can quote: a test waits it out.
const PREP_MINUTES = 1;
/// The time source publishes a round every few seconds: a deadline proved
/// with it is past once a round after it is out.
const ROUND_SLACK_MS = 4_000;

interface PinSecret {
  pin: string;
  salt: Uint8Array;
}

interface OrderTiming {
  driver_due: number | null;
  store_late_after: number | null;
  no_driver_after: number | null;
  store_was_late: boolean;
}

const sleepUntil = (micros: number) => new Promise((r) => setTimeout(r, Math.max(0, micros / 1000 - Date.now()) + ROUND_SLACK_MS));

await runScenario(async (scenario) => {
  const [customer, merchant, first, second] = await setupPlayersWithProperties(scenario, 4, () => ({
    pickup_grace_secs: 1,
    store_wait_secs: 2,
    replacement_window_secs: 20,
    collection_window_secs: 30,
  }));
  const all = [customer, merchant, first, second];
  for (const p of all) await useTestCoordinators(p, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);
  const balance = (p: typeof customer) => call(p, "ledger")<number>("get_balance", p.agentPubKey);
  const settlesTo = (p: typeof customer, order: Uint8Array, expected: number, why: string) =>
    retryUntil(
      async () => {
        await call(p, "dispatch")("settle_order", order).catch(() => 0);
        return balance(p);
      },
      (b) => b === expected,
      180,
      1000,
    ).then((b) => assert.equal(b, expected, why));
  const timing = (order: Uint8Array) => call(customer, "dispatch")<OrderTiming>("get_order_timing", order);
  const reachesStatus = (order: Uint8Array, wanted: string) => retryUntil(() => deliveryStatus(customer, order), (s) => s === wanted, 90, 1000);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(first, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  await call(second, "profiles")("create_profile", { display_name: "Olu", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: FOOD, available: true }));
  await sync();

  /// A delivery its store has accepted, quoting a minute's prep.
  async function placed() {
    const ref = actionHash(
      await retryUntilOk(() =>
        call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: FOOD, dropoff: ST_PETE, max_delivery_fee: null }),
      ),
    );
    await sync();
    await retryUntilOk(() => call(merchant, "dispatch")("accept_delivery_order", { order_original_action: ref, prep_minutes: PREP_MINUTES }));
    await sync();
    return ref;
  }
  /// `driver` bidding on it, accepted by the customer; then committing, and
  /// the store cooking.
  async function driving(ref: Uint8Array, driver: typeof customer) {
    const bid = actionHash(await retryUntilOk(() => call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: ref, eta_seconds: 600, to_store_seconds: 0, price_offer: FEE })));
    await sync();
    await retryUntilOk(() => call(customer, "dispatch")("accept_bid", { order_original_action: ref, bid_action: bid }));
    await sync();
    await commitAndCook(driver, merchant, ref, all);
  }
  async function drop(ref: Uint8Array, driver: typeof customer) {
    await call(driver, "dispatch")("drop_order", { order_ref: ref, beacon: await currentBeacon() });
    await sync();
  }

  // ===== Hot potato =====
  const potato = await placed();
  await driving(potato, first);
  assert.equal(await balance(first), -FOOD, "committing holds the driver's collateral");
  await assert.rejects(call(customer, "dispatch")("release_raw_for_testing", { order_original_action: potato }), /requires author role/, "a customer can't move a driver on");
  await assert.rejects(call(merchant, "dispatch")("release_raw_for_testing", { order_original_action: potato, beacon: await currentBeacon() }), /only once they've missed their offer or are late/, "nor can the store before they're due");
  await assert.rejects(call(first, "dispatch")("release_raw_for_testing", { order_original_action: potato }), /fresh proof of the time/, "a driver leaving says when");
  await drop(potato, first);
  assert.equal(await deliveryStatus(customer, potato), "Open", "dropped, it opens to bids again");
  await settlesTo(customer, potato, -FOOD, "the customer's driver pay comes back");
  assert.equal(await balance(first), -FOOD, "the store had started cooking: the driver still answers for the food");
  await driving(potato, second);
  await settlesTo(first, potato, 0, "another driver took it on: the first is clear");
  console.log("[PASS] a driver who leaves a cooked order answers for it, until another driver takes it on");

  // ===== The store late =====
  const code = await call(merchant, "dispatch")<PinSecret>("get_my_pickup_code", potato);
  await retryUntilOk(() => call(second, "attestation")("check_in_at_store", { order_ref: potato, code: code.pin }));
  await sync();
  assert.equal(await deliveryStatus(customer, potato), "DriverAtStore");
  assert.equal(await balance(merchant), -FEE, "checking the driver in holds the store's share of the fee, and the customer's again");
  await assert.rejects(call(second, "dispatch")("call_store_late", { order_ref: potato, beacon: await currentBeacon() }), /still has time/, "not before the store's wait is up");
  const lateAfter = (await timing(potato)).store_late_after;
  assert.ok(lateAfter, "a checked-in driver's wait is running");
  await sleepUntil(lateAfter);
  await retryUntilOk(async () => call(second, "dispatch")("call_store_late", { order_ref: potato, beacon: await currentBeacon() }));
  await sync();
  assert.equal(await deliveryStatus(customer, potato), "Open", "the order goes to another driver");
  await settlesTo(second, potato, FEE, "the driver leaves paid their whole fee by the store, with their collateral");
  await settlesTo(merchant, potato, -FEE, "the store pays it");
  await settlesTo(customer, potato, -FOOD, "what the customer set aside for that driver comes back");
  assert.equal((await timing(potato)).store_was_late, true, "the customer is told the store ran late");
  await retryUntilOk(() => call(customer, "dispatch")("cancel_order", potato));
  await sync();
  await settlesTo(customer, potato, 0, "the customer cancels for a full refund");
  assert.equal(await balance(merchant), -FEE, "the store gets nothing for the food");
  await retryUntil(() => call(customer, "reputation")<{ late_count: number }>("get_reputation_summary", { Store: store }), (s) => s.late_count === 1, 60, 1000);
  assert.equal((await call(customer, "reputation")<{ dropped_count: number }>("get_reputation_summary", { Driver: second.agentPubKey })).dropped_count, 0, "leaving a late store isn't a drop");
  console.log("[PASS] a store that keeps a checked-in driver waiting pays their fee, the order goes on, and the customer may cancel for a full refund");

});
