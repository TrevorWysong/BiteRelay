// Proves what a party's own clock can't do to someone else, and that an
// order's branched history never pays twice:
//
// - a store can't move on a driver who's committed (who'd then answer for
//   the food) without proof of the time from the network's time source, nor
//   before they're due;
// - nor end an order for want of a driver, nor keep the food of a customer
//   collecting it, without proof the window has passed;
// - an order changes drivers a bounded number of times;
// - a customer who cancelled an order on one branch of its history can't
//   take back their driver's pay on another.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, commitAndCook, currentBeacon, deliveryStatus, latestLedgerEntry, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators } from "./helpers.js";

const FOOD = 1000;
const FEE = 400;
/// The customer's half of the fee (the store covers the other half).
const CUSTOMER_SHARE = FEE / 2;

await runScenario(async (scenario) => {
  const [customer, merchant, driver, other] = await setupPlayersWithProperties(scenario, 4, () => ({
    pickup_grace_secs: 600,
    replacement_window_secs: 600,
    collection_window_secs: 600,
    max_driver_changes: 1,
  }));
  const all = [customer, merchant, driver, other];
  for (const p of all) await useTestCoordinators(p, ["dispatch", "ledger"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);
  const forced = (p: typeof customer, order: Uint8Array, cancellation: string, beacon: unknown) =>
    call(p, "dispatch")("force_order_update_for_testing", { order_original_action: order, next_status: "Cancelled", delivery_receipts: [], cancellation, beacon });

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  await call(other, "profiles")("create_profile", { display_name: "Olu", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: FOOD, available: true }));
  await sync();

  async function placed() {
    const ref = actionHash(
      await retryUntilOk(() =>
        call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: FOOD, dropoff: ST_PETE, max_delivery_fee: null }),
      ),
    );
    await sync();
    await retryUntilOk(() => call(merchant, "dispatch")("accept_delivery_order", { order_original_action: ref, prep_minutes: 1 }));
    await sync();
    return ref;
  }
  async function bidAndAccept(ref: Uint8Array, by: typeof customer) {
    const bid = actionHash(await retryUntilOk(() => call(by, "dispatch")<HcRecord>("submit_bid", { order_ref: ref, eta_seconds: 600, to_store_seconds: 0, price_offer: FEE })));
    await sync();
    return call(customer, "dispatch")("accept_bid", { order_original_action: ref, bid_action: bid });
  }

  // ===== Moving a committed driver on =====
  const order = await placed();
  await retryUntilOk(() => bidAndAccept(order, driver));
  await sync();
  await commitAndCook(driver, merchant, order, all);
  await assert.rejects(call(merchant, "dispatch")("release_raw_for_testing", { order_original_action: order }), /fresh proof of the time/, "a store's own clock can't make a committed driver late");
  await assert.rejects(
    call(merchant, "dispatch")("release_raw_for_testing", { order_original_action: order, beacon: await currentBeacon() }),
    /only once they've missed their offer or are late/,
    "nor can proof of a time before they're due",
  );
  await assert.rejects(call(merchant, "dispatch")("move_driver_on", { order_ref: order, beacon: await currentBeacon() }), /still has time/, "the store's app holds it to the same");
  console.log("[PASS] a store moves on a committed driver only with proof they're late");

  // ===== Ending an order for want of a driver =====
  await call(driver, "dispatch")("drop_order", { order_ref: order, beacon: await currentBeacon() });
  await sync();
  await assert.rejects(forced(merchant, order, "NoDriver", null), /fresh proof of the time/, "a store's own clock can't end the window");
  await assert.rejects(forced(merchant, order, "NoDriver", await currentBeacon()), /waits the network's window/, "nor proof of a time inside it");
  console.log("[PASS] a store ends an order for want of a driver only with proof the window has passed");

  // ===== A bounded number of driver changes =====
  await assert.rejects(bidAndAccept(order, other), /changed drivers/, "past the network's limit, nobody takes it on");
  console.log("[PASS] an order changes drivers a bounded number of times");

  // ===== Keeping a collecting customer's food =====
  const collecting = await placed();
  await call(customer, "dispatch")("request_collect", collecting);
  await sync();
  // With no driver, the store's own app records it.
  await retryUntil(
    async () => {
      await call(merchant, "dispatch")("record_collecting", { order_ref: collecting }).catch(() => null);
      return deliveryStatus(customer, collecting);
    },
    (s) => s === "Collecting",
    60,
    1000,
  );
  await sync();
  await assert.rejects(forced(merchant, collecting, "NotCollected", null), /fresh proof of the time/, "a store's own clock can't end the customer's window");
  await assert.rejects(forced(merchant, collecting, "NotCollected", await currentBeacon()), /window has passed/, "nor proof of a time inside it");
  await assert.rejects(call(merchant, "dispatch")("mark_not_collected", { order_ref: collecting, beacon: await currentBeacon() }), /still has time/, "the store's app holds it to the same");
  console.log("[PASS] a store keeps a collecting customer's food only with proof their window has passed");

  // ===== A branched history pays once =====
  const branched = await placed();
  await retryUntilOk(() => bidAndAccept(branched, other));
  await sync();
  await commitAndCook(other, merchant, branched, all);
  const cooking = actionHash(await call(customer, "dispatch")<HcRecord>("get_order", branched));
  // On one branch the customer cancels (owing the driver their fee); on
  // another, from the same version, the driver leaves.
  // (Each app writes on its own too, so a write can lose the race for its
  // chain's head; retried.)
  await retryUntilOk(() => call(customer, "dispatch")("branch_order_for_testing", { version: cooking, next_status: "Cancelled", cancellation: "ByCustomer" }));
  const release = await retryUntilOk(async () => call(other, "dispatch")<Uint8Array>("branch_order_for_testing", { version: cooking, next_status: "Open", release: true, beacon: await currentBeacon() }));
  await sync();
  const holds = await call(customer, "ledger")<{ hold: Uint8Array; payer: Uint8Array; purpose: string | Record<string, unknown> }[]>("holds_for_order", branched);
  const driverPay = holds.find((h) => typeof h.purpose === "object" && "DriverPay" in h.purpose);
  assert.ok(driverPay, "the customer set aside the driver's pay");
  const last = await latestLedgerEntry(customer);
  await assert.rejects(
    call(customer, "ledger")("create_raw_ledger_entry_for_testing", {
      kind: { Collect: { hold: driverPay.hold, portion: "Fee", basis: release } },
      amount: CUSTOMER_SHARE,
      balance: last.balance + CUSTOMER_SHARE,
      in_hand: last.in_hand,
      previous: last.hash,
    }),
    /isn't grounds/,
    "a customer who cancelled can't take the driver's pay back on the driver's branch",
  );
  console.log("[PASS] a customer's cancelling on one branch binds them on another");
});
