// Proves the protections against people gaming each other, on a prepaid
// network (no credit: every hold is money someone deposited):
//
// - a store can accept a delivery only if it can cover a driver's fee,
//   which it sets aside when it checks them in;
// - a driver learns a customer's exact address only once they've
//   committed, collateral posted -- never on winning a bid;
// - while a driver who left an order cooking answers for it, its customer
//   can't cancel (the store would be paid for the food twice);
// - a driver who leaves from the counter, checked in, has their
//   collateral back.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, commitAndCook, currentBeacon, decodeEntry, deliveryStatus, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators, retryingCaller } from "./helpers.js";

const FOOD = 1000;
const FEE = 400;
const CAP = 600;

interface PinSecret {
  pin: string;
  salt: Uint8Array;
}

await runScenario(async (scenario) => {
  const [issuer, customer, merchant, driver, other] = await setupPlayersWithProperties(scenario, 5, (keys) => ({ issuers: [keys[0]], credit_limit_cents: 0 }));
  const all = [issuer, customer, merchant, driver, other];
  for (const p of all) await useTestCoordinators(p, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const balance = (p: typeof customer) => call(p, "ledger")<number>("get_balance", p.agentPubKey);
  let references = 0;
  async function fund(p: typeof customer, amount: number) {
    await call(issuer, "ledger")("issue_grant", { to: p.agentPubKey, amount, reference: `top-up-${++references}` });
    await sync();
    await retryUntilOk(() => call(p, "ledger")<number>("collect_grants", null).then((n) => (n > 0 ? n : Promise.reject(new Error("not yet")))));
  }

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  await call(other, "profiles")("create_profile", { display_name: "Olu", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: FOOD, available: true }));
  await fund(customer, 10_000);
  await fund(driver, 5_000);
  await fund(other, 5_000);

  const placed = async () => {
    const ref = actionHash(
      await retryUntilOk(() =>
        call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: FOOD, dropoff: ST_PETE, max_delivery_fee: CAP }),
      ),
    );
    await sync();
    return ref;
  };
  const accepted = (ref: Uint8Array) => call(merchant, "dispatch")("accept_delivery_order", { order_original_action: ref, prep_minutes: 1 });

  // ===== A store needs a float =====
  const order = await placed();
  await assert.rejects(accepted(order), /can't cover a driver's fee/, "a store with nothing to check a driver in with can't accept a delivery");
  await fund(merchant, CAP);
  await retryUntilOk(() => accepted(order));
  await sync();
  console.log("[PASS] a store accepts a delivery only if it can cover a driver's fee");

  // ===== The address, only once committed =====
  const bid = actionHash(await retryUntilOk(() => call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, to_store_seconds: 0, price_offer: FEE })));
  await sync();
  await call(customer, "dispatch")<HcRecord>("accept_bid", { order_original_action: order, bid_action: bid });
  await sync();
  const addressFor = async () => (await call(driver, "dispatch")<{ dropoff: unknown }>("get_order_private_details", order)).dropoff;
  assert.equal(await addressFor(), null, "winning a bid reveals nothing");
  await commitAndCook(driver, merchant, order, all);
  const shared = await retryUntil(addressFor, (dropoff) => dropoff !== null, 60, 1000);
  assert.ok(shared, "the customer's app shares the address once the driver has committed");
  console.log("[PASS] a driver learns the address only once they've committed");

  // ===== No cancelling while a driver answers for it =====
  await call(driver, "dispatch")("drop_order", { order_ref: order, beacon: await currentBeacon() });
  await sync();
  await assert.rejects(call(customer, "dispatch")("cancel_order", order), /answer for it/, "the customer is told to wait or collect it");
  // Carrying the drop's time proof forward, as any later step does.
  const { beacon } = decodeEntry<{ beacon: unknown }>(await call(customer, "dispatch")<HcRecord>("get_order", order));
  await assert.rejects(
    call(customer, "dispatch")("force_order_update_for_testing", { order_original_action: order, next_status: "Cancelled", delivery_receipts: [], cancellation: "ByCustomer", beacon }),
    /answers for it until another takes it on/,
    "nor can a modified app cancel it",
  );
  console.log("[PASS] while a driver who left it cooking answers for it, the customer can't cancel");

  // ===== Leaving from the counter =====
  const second = actionHash(await retryUntilOk(() => call(other, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, to_store_seconds: 0, price_offer: FEE })));
  await sync();
  await retryUntilOk(() => call(customer, "dispatch")("accept_bid", { order_original_action: order, bid_action: second }));
  await sync();
  await commitAndCook(other, merchant, order, all);
  const before = 5_000;
  const code = await call(merchant, "dispatch")<PinSecret>("get_my_pickup_code", order);
  await retryUntilOk(() => call(other, "attestation")("check_in_at_store", { order_ref: order, code: code.pin }));
  await sync();
  assert.equal(await deliveryStatus(customer, order), "DriverAtStore");
  await call(other, "dispatch")("drop_order", { order_ref: order, beacon: await currentBeacon() });
  await sync();
  const back = await retryUntil(
    async () => {
      await call(other, "dispatch")("settle_order", order).catch(() => 0);
      return balance(other);
    },
    (b) => b === before,
    60,
    1000,
  );
  assert.equal(back, before, "a driver who leaves from the counter has their collateral back");
  console.log("[PASS] a driver who leaves from the counter has their collateral back");
});
