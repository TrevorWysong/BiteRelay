// Proves who pays when no driver brings an order:
//
// - if no driver takes on an order another left cooking in time, the
//   store's app ends it: the customer is refunded and the driver who left
//   it pays for the food;
// - a driver's report that the store wouldn't check them in moves no money
//   but shows on the store's record;
// - a customer can ask to collect it; once their driver is late, the
//   store's app records it, and the store refunds its share of the fee.
//
// A driver leaving and a store running late are `late-orders.test.ts`.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, commitAndCook, currentBeacon, deliveryStatus, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators, retryingCaller } from "./helpers.js";

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
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const balance = (p: typeof customer) => call(p, "ledger")<number>("get_balance", p.agentPubKey);
  const settlesTo = (p: typeof customer, order: Uint8Array, expected: number, why: string) =>
    retryUntil(
      async () => {
        await call(p, "dispatch")("settle_order", order).catch(() => 0);
        return balance(p);
      },
      (b) => b === expected,
      90,
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

  // ===== No driver comes =====
  const abandoned = await placed();
  await driving(abandoned, first);
  await drop(abandoned, first);
  await assert.rejects(call(merchant, "dispatch")("end_for_no_driver", { order_ref: abandoned, beacon: await currentBeacon() }), /still has time/, "another driver gets the window");
  const endsAfter = (await timing(abandoned)).no_driver_after;
  assert.ok(endsAfter, "the window is running");
  await sleepUntil(endsAfter);
  // The store's app ends it, with proof of the time; this does the same.
  await retryUntil(
    async () => {
      await call(merchant, "dispatch")("end_for_no_driver", { order_ref: abandoned, beacon: await currentBeacon() }).catch(() => null);
      return deliveryStatus(customer, abandoned);
    },
    (s) => s === "Cancelled",
    60,
    1000,
  );
  await sync();
  await settlesTo(customer, abandoned, 0, "the customer is refunded in full");
  await settlesTo(merchant, abandoned, FOOD, "the driver's collateral pays the store for the food");
  await settlesTo(first, abandoned, -FOOD, "the driver who left it pays for it");
  await retryUntil(() => call(customer, "reputation")<{ dropped_count: number }>("get_reputation_summary", { Driver: first.agentPubKey }), (s) => s.dropped_count === 1, 60, 1000);
  console.log("[PASS] if no driver takes on a cooked order, the customer is refunded and the driver who left it pays");

  // A driver's report the store wouldn't check them in moves no money.
  await call(first, "dispatch")("report_check_in_refused", abandoned);
  await retryUntil(() => call(customer, "reputation")<{ check_in_refused_count: number }>("get_reputation_summary", { Store: store }), (s) => s.check_in_refused_count === 1, 60, 1000);
  console.log("[PASS] a driver's report that the store wouldn't check them in shows on the store's record");

  // ===== The customer collects it =====
  const collected = await placed();
  await driving(collected, second);
  await call(customer, "dispatch")("request_collect", collected);
  await sync();
  assert.equal(await deliveryStatus(customer, collected), "MerchantConfirmed", "the driver still has time");
  const due = (await timing(collected)).driver_due;
  assert.ok(due, "the driver is due at the store");
  await sleepUntil(due);
  // The store's app records it once the driver is late, with proof of the
  // time; this does the same.
  await retryUntil(
    async () => {
      await call(merchant, "dispatch")("record_collecting", { order_ref: collected, beacon: await currentBeacon() }).catch(() => null);
      return deliveryStatus(customer, collected);
    },
    (s) => s === "Collecting",
    60,
    1000,
  );
  await sync();
  const handover = await call(customer, "dispatch")<PinSecret>("get_my_handover_code", collected);
  await retryUntilOk(() => call(merchant, "dispatch")("hand_over_collection", { order_original_action: collected, code: handover }));
  await sync();
  await reachesStatus(collected, "Collected");
  await settlesTo(customer, collected, -FOOD + STORE_SHARE, "the customer pays for the food, less the store's share of the fee");
  await settlesTo(merchant, collected, FOOD + FOOD - STORE_SHARE, "the store is paid for the food, less its share of the fee");
  await settlesTo(second, collected, 0, "the late driver's collateral comes back");
  console.log("[PASS] a customer collecting a late order is refunded the store's share of the fee");
});
