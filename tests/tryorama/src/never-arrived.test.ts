// Proves a delivery that never arrives leaves its driver accountable, with
// no referee: the customer claims it, the store decides, and the money
// follows that one decision.
//
// - Decided undelivered: the customer gets back the food, the fee and the
//   tip; the store its share of the fee; and the driver's collateral pays
//   the store for the food. Recorded against the driver.
// - A driver who turns up late can still complete it with proof; the store
//   then decides it delivered, the driver is paid, and the claim is
//   recorded against the customer.
// - Only the order's store decides, once; *delivered* only on the order
//   completed with proof, *undelivered* only on the customer's claim; and
//   no one collects on a decision that doesn't entitle them -- so no two
//   payouts can contradict each other.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, collectFromStore, commitAndCook, decodeEntry, handOff, latestLedgerEntry, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators, retryingCaller } from "./helpers.js";

const FOOD = 1000;
const FEE = 400;
const TIP = 150;

interface PinSecret {
  pin: string;
  salt: Uint8Array;
}
interface Summary {
  dispute_resolved_against_count: number;
  total_collateral_forfeited: number;
}

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await setupPlayersWithProperties(scenario, 3, () => ({}));
  const all = [customer, merchant, driver];
  for (const p of all) await useTestCoordinators(p, ["dispatch", "ledger"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const balance = (p: typeof customer) => call(p, "ledger")<number>("get_balance", p.agentPubKey);
  /// `p` settling what it can on `order` until its balance is `expected`.
  const settlesTo = (p: typeof customer, order: Uint8Array, expected: number) =>
    retryUntil(
      async () => {
        await call(p, "dispatch")("settle_order", order).catch(() => 0);
        return balance(p);
      },
      (b) => b === expected,
      60,
      1000,
    );
  const summary = (target: object) => call(merchant, "reputation")<Summary>("get_reputation_summary", target);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: FOOD, available: true }));
  await sync();

  /// A delivery picked up on the store's confirmation, out for delivery.
  async function outForDelivery() {
    const ref = actionHash(
      await retryUntilOk(() =>
        call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: FOOD, dropoff: ST_PETE, max_delivery_fee: null, tip_cents: TIP }),
      ),
    );
    await sync();
    await acceptOrder(merchant, ref, all);
    const bid = actionHash(await retryUntilOk(() => call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: ref, eta_seconds: 600, price_offer: FEE })));
    await sync();
    await retryUntilOk(() => call(customer, "dispatch")("accept_bid", { order_original_action: ref, bid_action: bid }));
    await sync();
    await commitAndCook(driver, merchant, ref, all);
    await collectFromStore(driver, merchant, ref, all);
    await sync();
    return ref;
  }
  const raw = (p: typeof customer, input: unknown) => call(p, "dispatch")("create_raw_outcome_for_testing", input);
  const latestVersion = async (ref: Uint8Array) => actionHash(await call(customer, "dispatch")<HcRecord>("get_order", ref));
  type Hold = { hold: Uint8Array; purpose: string | object; shares: { portion: string; amount: number }[] };
  const holdsOf = (ref: Uint8Array) => call(merchant, "ledger")<Hold[]>("holds_for_order", ref);
  const holdFor = (holds: Hold[], purpose: string) => holds.find((h) => typeof h.purpose === "object" && purpose in h.purpose);
  /// The store's share of the fee (its subsidy) on an order, if any.
  const storeShare = async (ref: Uint8Array) => holdFor(await holdsOf(ref), "Subsidy")?.shares[0]?.amount ?? 0;

  // ===== It never arrives =====
  const [c0, m0, d0] = [await balance(customer), await balance(merchant), await balance(driver)];
  const lost = await outForDelivery();
  const pickedUp = await latestVersion(lost);
  await assert.rejects(call(merchant, "dispatch")("decide_not_delivered", lost), /hasn't said it never arrived/, "the store can't decide it undelivered unprompted");
  await assert.rejects(raw(merchant, { order: lost, outcome: { NotDelivered: { claim: pickedUp } } }), /cites the customer's claim/, "nor forge one without the customer's claim");
  await assert.rejects(raw(merchant, { order: lost, outcome: { Delivered: { proof: pickedUp } } }), /completed on proof/, "nor decide it delivered without the proof");
  await call(customer, "dispatch")("claim_never_arrived", lost);
  await sync();
  const claim = await latestVersion(lost);
  await assert.rejects(raw(driver, { order: lost, outcome: { Delivered: { proof: claim } } }), /only the order's store/, "the driver can't decide it");
  await assert.rejects(raw(customer, { order: lost, outcome: { NotDelivered: { claim } } }), /only the order's store/, "nor the customer");
  const notDelivered = await retryUntilOk(() => call(merchant, "dispatch")<Uint8Array>("decide_not_delivered", lost));
  await sync();
  await assert.rejects(raw(merchant, { order: lost, outcome: { NotDelivered: { claim } } }), /decided once/, "and the store decides once");
  console.log("[PASS] only the store decides an order never arrived, once, on the customer's claim");

  // Nobody collects what this decision doesn't give them.
  assert.ok((await call(customer, "dispatch")<{ not_delivered: boolean }>("get_order_decisions", lost)).not_delivered, "everyone sees the store's decision");
  const holds = await holdsOf(lost);
  const driverPay = holdFor(holds, "DriverPay")!;
  const collateral = holdFor(holds, "Collateral")!;
  const customerFee = driverPay.shares.find((share) => share.portion === "Fee")!.amount;
  const forge = async (p: typeof customer, hold: Uint8Array, portion: string, amount: number) => {
    const latest = await latestLedgerEntry(p);
    return call(p, "ledger")("create_raw_ledger_entry_for_testing", { kind: { Collect: { hold, portion, basis: notDelivered } }, amount, balance: latest.balance + amount, in_hand: latest.in_hand, previous: latest.hash });
  };
  await assert.rejects(forge(driver, driverPay.hold, "Fee", customerFee), /isn't grounds/, "the driver can't take their fee on an order that never arrived");
  // Refused either way: no grounds -- or, once the driver's app has
  // forfeited it on the store's decision, already decided.
  await assert.rejects(forge(driver, collateral.hold, "Collateral", FOOD), /isn't grounds|already been decided/, "nor their collateral back");

  await settlesTo(customer, lost, c0);
  await settlesTo(driver, lost, d0 - FOOD);
  await settlesTo(merchant, lost, m0 + FOOD);
  console.log("[PASS] never arrived: the customer and store are made whole, and the driver's collateral pays for the food");
  const driverRecord = await retryUntil(() => summary({ Driver: driver.agentPubKey }), (s) => s.dispute_resolved_against_count === 1);
  assert.equal(driverRecord.total_collateral_forfeited, FOOD);
  console.log("[PASS] ...recorded against the driver");

  // Every event is checked against what it cites.
  const event = (p: typeof customer, kind: unknown, basis: Uint8Array) =>
    call(p, "reputation")("record_event", { target: { Driver: driver.agentPubKey }, order_ref: lost, kind, basis });
  const refused = /only the order's own parties record events about it, as its records show them/;
  await assert.rejects(event(merchant, { CollateralForfeited: { amount: FOOD * 10 } }, notDelivered), refused, "forfeited collateral is exactly the bid's");
  await assert.rejects(event(merchant, "OrderCompleted", notDelivered), refused, "a store can't credit a driver with an order that never arrived");
  await assert.rejects(event(customer, "OrderCompleted", pickedUp), refused, "nor can anyone but the store, citing anything else");
  await assert.rejects(event(customer, "DisputeResolvedAgainst", notDelivered), refused, "an outcome event is the store's alone");
  console.log("[PASS] reputation events are checked against the decisions and versions they cite");

  // ===== The driver turns up after all =====
  const [c1, m1, d1] = [await balance(customer), await balance(merchant), await balance(driver)];
  const late = await outForDelivery();
  await call(customer, "dispatch")("claim_never_arrived", late);
  await sync();
  const code = await call(customer, "dispatch")<PinSecret>("get_my_handover_code", late);
  await call(driver, "attestation")("record_leg", { order_ref: late, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE, scanned: code });
  await retryUntilOk(() => call(driver, "dispatch")("complete_delivery", { order_original_action: late }));
  await sync();
  assert.equal(decodeEntry<{ status: string }>(await call(customer, "dispatch")<HcRecord>("get_order", late)).status, "Delivered");
  await assert.rejects(call(merchant, "dispatch")("decide_not_delivered", late), /hasn't said it never arrived|already decided/, "delivered with proof, the store can't decide otherwise");
  // The store's app decides it delivered; the driver's paid on that, and
  // the store for the food once the report window has run.
  const subsidy = await storeShare(late);
  await settlesTo(driver, late, d1 + FEE + TIP);
  await settlesTo(merchant, late, m1 + FOOD - subsidy);
  await settlesTo(customer, late, c1 - FOOD - (FEE - subsidy) - TIP);
  console.log("[PASS] a driver who turns up late completes it with proof, and is paid");
  await retryUntil(() => summary({ Customer: customer.agentPubKey }), (s) => s.dispute_resolved_against_count === 1);
  console.log("[PASS] ...and the customer's claim is recorded against them");
});
