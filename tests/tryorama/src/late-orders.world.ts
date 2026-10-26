// The world both late-order tests run in (late-orders, store-late): a
// customer, a store with a stew, and two drivers, on a network whose waits
// are seconds long -- and the steps every one of their orders takes.
import assert from "node:assert/strict";
import { dhtSync, type Scenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, commitAndCook, currentBeacon, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators, retryingCaller } from "./helpers.js";

export const FOOD = 1000;
export const FEE = 400;
/// The shortest prep a store can quote: a test waits it out.
export const PREP_MINUTES = 1;
/// The time source publishes a round every few seconds: a deadline proved
/// with it is past once a round after it is out.
export const ROUND_SLACK_MS = 4_000;

export interface PinSecret {
  pin: string;
  salt: Uint8Array;
}

export interface OrderTiming {
  driver_due: number | null;
  store_late_after: number | null;
  no_driver_after: number | null;
  store_was_late: boolean;
}

export const sleepUntil = (micros: number) => new Promise((r) => setTimeout(r, Math.max(0, micros / 1000 - Date.now()) + ROUND_SLACK_MS));

/// The world, set up: its players, the store's stew, and each step an order
/// takes.
export async function lateOrderWorld(scenario: Scenario) {
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
      180,
      1000,
    ).then((b) => assert.equal(b, expected, why));
  const timing = (order: Uint8Array) => call(customer, "dispatch")<OrderTiming>("get_order_timing", order);

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

  return { customer, merchant, first, second, store, call, sync, balance, settlesTo, timing, placed, driving, drop };
}
