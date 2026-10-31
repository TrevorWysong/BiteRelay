// Points are earned only once an order's refund period is over -- after the
// store settles it and the network's window to appeal that settlement has
// passed -- so they always match what the customer finally paid. Until
// then they show as pending. An appealed order earns once its arbiter
// rules, less what they awarded (docs/REWARDS.md). Forgeries are written
// raw (test-utils), as a modified app would.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, retryUntil, retryUntilOk, retryingCaller, setupPlayersWithProperties, useTestCoordinators } from "./helpers.js";

/// Seconds after a settlement its customer may appeal it, here.
const WINDOW_SECS = 25;

interface OrderPoints {
  points: number;
  status: string | { RefundPeriod: { until: number } };
}

await runScenario(async (scenario) => {
  const [customer, merchant, arbiter] = await setupPlayersWithProperties(scenario, 3, (keys) => ({ arbiters: [keys[2]], appeal_window_secs: WINDOW_SECS }));
  const all = [customer, merchant, arbiter];
  for (const p of all) await useTestCoordinators(p, ["rewards"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const rewards = call(customer, "rewards");

  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 2000, available: true }));
  await call(merchant, "rewards")("save_program", {
    catalog_ref: store, active: true, name: "Mo's Rewards", points_name: "points", tagline: "", accent: "Ember",
    earn: { points_per_dollar: 10, min_order_cents: 0, max_per_order: null, welcome_bonus: 0, item_bonuses: [], happy_hours: [] },
    tiers: [], rewards: [], birthday_points: 0, expiry_days: null, max_balance: null, time_zone: "UTC",
  });
  await sync();

  /// A pickup of stew the customer collects and the store settles; the
  /// store's acceptance of it, and when it settled.
  const settled = async () => {
    const order = actionHash(await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 2000 })));
    await sync();
    const accepted = actionHash(await retryUntilOk(() => call(merchant, "dispatch")<HcRecord>("accept_pickup_order", { order_original_action: order })));
    await call(merchant, "dispatch")("mark_ready_for_pickup", order);
    await sync();
    await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", order), 40);
    await sync();
    await retryUntil(() => call(merchant, "dispatch")("settle_order", order).then(() => call(customer, "dispatch")<{ refund: number | null }>("get_order_decisions", order)), (d) => d.refund !== null, 60, 1000);
    await sync();
    const settlement = await retryUntil(() => call(customer, "dispatch")<ActionHash | null>("order_settlement", order), (s) => !!s);
    return { order, accepted, settlement: settlement! };
  };
  const balance = () => rewards<{ balance: number; pending_points: number }>("my_card", store);
  /// An earning written raw, after the customer's latest entry here.
  const earnRaw = async (order: ActionHash, settlement: ActionHash, accepted: ActionHash, ruling: ActionHash | null, points: number) => {
    const card = await rewards<{ state: Record<string, unknown> | null; history: { entry: ActionHash }[] }>("my_card", store);
    const state = card.state ?? { balance: 0, year: new Date().getUTCFullYear(), earned_this_year: 0, earned_last_year: 0, lifetime_earned: 0, orders: 0, first_earned_at: null, last_earned_at: null };
    return rewards("create_raw_points_entry_for_testing", {
      catalog_ref: store,
      kind: { Earn: { order, settlement, accepted, ruling } },
      points,
      state: { ...state, balance: (state.balance as number) + points },
      previous: card.history[0]?.entry ?? null,
    });
  };

  // ===== Settled: pending through the refund period, then earned =====
  const first = await settled();
  const pending = await rewards<OrderPoints>("order_points", first.order);
  assert.ok(typeof pending.status === "object" && "RefundPeriod" in pending.status, "pending until the refund period ends");
  assert.equal(pending.points, 200);
  assert.equal(await rewards("earn_for_order", first.order), null, "not earned yet");
  assert.deepEqual([(await balance()).balance, (await balance()).pending_points], [0, 200], "shown as pending on the card");
  await assert.rejects(earnRaw(first.order, first.settlement, first.accepted, null, 200), /refund period is over/, "the network refuses it early too");
  console.log("[PASS] a settled order's points are pending through its refund period, and can't be taken early");

  await retryUntil(() => rewards<ActionHash | null>("earn_for_order", first.order), (h) => !!h, 60, 1000);
  assert.equal((await balance()).balance, 200);
  assert.equal((await rewards<OrderPoints>("order_points", first.order)).status, "Earned");
  console.log("[PASS] once the refund period is over, they're earned");

  // ===== Appealed: earned on the ruling, less the award =====
  const second = await settled();
  const appeal = await call(customer, "dispatch")<ActionHash>("file_appeal", { order: second.order, amount: 1500, note: "Cold", photo_data_uri: "" });
  await sync();
  // Past the window: still pending, on the arbiter.
  await new Promise((resolve) => setTimeout(resolve, WINDOW_SECS * 1000));
  assert.equal((await rewards<OrderPoints>("order_points", second.order)).status, "InReview");
  assert.equal(await rewards("earn_for_order", second.order), null, "not before the ruling");
  await assert.rejects(earnRaw(second.order, second.settlement, second.accepted, null, 200), /arbiter's ruling/, "an appealed order can't earn as if it weren't");
  await call(arbiter, "dispatch")("rule_on_appeal", { appeal, award: 1000, reasons: "Half of it" });
  await sync();
  await retryUntil(() => rewards<ActionHash | null>("earn_for_order", second.order), (h) => !!h, 60, 1000);
  assert.equal((await balance()).balance, 200 + 100, "earned on what the customer kept paying: $10");
  console.log("[PASS] an appealed order earns once its arbiter rules, on what the customer finally paid");
});
