// A store's rewards program (docs/REWARDS.md): only its owner runs it;
// points come only from what was paid -- earned once per settled order, at
// the rate its program version set -- or from the store's own grants; and
// they're spent only on a reward the member can afford, by one order each.
// Points spent on an order the store calls off come back from the store.
// Forgeries are written raw (test-utils), as a modified app would.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, bytesEqual, decodeEntry, retryUntil, retryUntilOk, retryingCaller, testApp, useTestCoordinators } from "./helpers.js";

interface PointsState {
  balance: number;
  year: number;
  earned_this_year: number;
  earned_last_year: number;
  lifetime_earned: number;
  orders: number;
  first_earned_at: number | null;
  last_earned_at: number | null;
}
interface Card {
  balance: number;
  tier: number;
  state: PointsState | null;
  program: { version: ActionHash } | null;
  history: { kind: Record<string, unknown>; points: number }[];
}
interface Order {
  rewards: { program: ActionHash; redemption: ActionHash | null } | null;
  order_total: number;
}

await runScenario(async (scenario) => {
  const [customer, merchant, stranger] = await scenario.addPlayersWithApps([testApp, testApp, testApp]);
  const all = [customer, merchant, stranger];
  await scenario.shareAllAgents();
  for (const p of all) await useTestCoordinators(p, ["rewards", "dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const rewards = (p: typeof customer) => call(p, "rewards");
  const card = (p: typeof customer = customer) => rewards(p)<Card>("my_card", store);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = async (name: string, price_cents: number) => actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name, price_cents, available: true }));
  const soup = await item("Soup", 1000);
  const bread = await item("Bread", 400);
  const elsewhere = actionHash(await call(stranger, "catalog")<HcRecord>("publish_catalog", { business_name: "Elsewhere", location: ST_PETE }));
  const theirs = actionHash(await call(stranger, "catalog")<HcRecord>("add_menu_item", { catalog_ref: elsewhere, name: "Pie", price_cents: 500, available: true }));
  await sync();

  // ===== The program: its owner's alone, within its limits =====
  const program = {
    catalog_ref: store,
    active: true,
    name: "Mo's Rewards",
    points_name: "points",
    tagline: "Soup gets you bread",
    accent: "Ember",
    earn: { points_per_dollar: 10, min_order_cents: 0, max_per_order: null, welcome_bonus: 50, item_bonuses: [{ item_ref: bread, percent: 200 }], happy_hours: [] },
    tiers: [{ name: "Gold", threshold: 1000, percent: 150, perk: "" }],
    rewards: [
      { id: 1, name: "Free bread", cost: 100, benefit: { FreeItem: { item_ref: bread, quantity: 1 } }, min_tier: 0 },
      { id: 2, name: "$5 off", cost: 50, benefit: { FlatOffSubtotal: 500 }, min_tier: 1 },
    ],
    birthday_points: 0,
    expiry_days: null,
    max_balance: null,
    time_zone: "UTC",
  };
  await assert.rejects(rewards(stranger)("save_program", program), /Only the store's owner/);
  await assert.rejects(rewards(stranger)("create_raw_program_for_testing", program), /only a store's owner/, "the network refuses it too");
  await assert.rejects(rewards(merchant)("save_program", { ...program, earn: { ...program.earn, points_per_dollar: 500 } }), /points a dollar/);
  await assert.rejects(rewards(merchant)("save_program", { ...program, rewards: [{ ...program.rewards[0], benefit: { FreeItem: { item_ref: theirs, quantity: 1 } } }] }), /own store's items/, "only its own menu");
  await rewards(merchant)("save_program", program);
  await assert.rejects(rewards(merchant)("create_raw_program_for_testing", program), /one program/, "one program a store; it changes by updates");
  await sync();
  console.log("[PASS] a store's program is its owner's alone, once, within its limits and its own menu");

  // ===== An order joins the program and earns once it's settled =====
  const pickup = (items: { item_ref: Uint8Array; quantity: number }[], order_total: number, reward: number | null = null) =>
    call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items, order_total, reward });
  const fulfil = async (order: ActionHash) => {
    await sync();
    await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order }));
    await call(merchant, "dispatch")("mark_ready_for_pickup", order);
    await sync();
    await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", order), 40);
    await sync();
    // The store settles once the customer's report window passes.
    await retryUntil(() => call(merchant, "dispatch")("settle_order", order).then(() => call(customer, "dispatch")<{ refund: number | null }>("get_order_decisions", order)), (d) => d.refund !== null, 60, 1000);
    await sync();
  };
  const first = await retryUntilOk(() => pickup([{ item_ref: soup, quantity: 1 }, { item_ref: bread, quantity: 1 }], 1400));
  const firstRef = actionHash(first);
  assert.ok(decodeEntry<Order>(first).rewards, "it joins the store's program");
  await fulfil(firstRef);
  // Earned by the customer's own sweep, or asked for here: either way once.
  const earnedCard = await retryUntil(() => rewards(customer)("earn_for_order", firstRef).then(() => card()), (c) => c.balance > 0, 30, 1000);
  if (earnedCard.balance === 0) console.log("settlement:", await call(customer, "dispatch")("order_settlement", firstRef), "card:", JSON.stringify(earnedCard));
  // $10 of soup at 10 a dollar, $4 of bread at twice that, and the welcome.
  assert.equal(earnedCard.balance, 100 + 80 + 50);
  assert.equal(await rewards(customer)("earn_for_order", firstRef), null, "once");
  console.log("[PASS] a settled order earns its food at the program's rate, bonus items faster, with a welcome -- once");

  // ===== Nobody states their own points =====
  const latest = async () => {
    const c = await card();
    const entry = c.history[0];
    return { state: c.state!, hash: (entry as unknown as { entry: ActionHash }).entry };
  };
  const forge = async (p: typeof customer, kind: unknown, points: number, state: Partial<PointsState>, previous?: ActionHash | null) => {
    const last = p === customer ? await latest() : { state: { balance: 0, year: 2026, earned_this_year: 0, earned_last_year: 0, lifetime_earned: 0, orders: 0, first_earned_at: null, last_earned_at: null }, hash: null };
    return rewards(p)("create_raw_points_entry_for_testing", { catalog_ref: store, kind, points, state: { ...last.state, ...state }, previous: previous === undefined ? last.hash : previous });
  };
  const settlement = await call(customer, "dispatch")<ActionHash | null>("order_settlement", firstRef);
  const before = (await latest()).state;
  await assert.rejects(forge(customer, { Earn: { order: firstRef, settlement } }, 230, { balance: before.balance + 230 }), /earns once/, "the same order twice");
  await assert.rejects(forge(stranger, { Earn: { order: firstRef, settlement } }, 230, { balance: 230 }, null), /own customer/, "someone else's order");
  await assert.rejects(forge(customer, { Gift: { grant: firstRef } }, 1000, { balance: before.balance + 1000 }), /store's grant/, "a gift nobody gave");
  await assert.rejects(forge(customer, { Redeem: { program: (await card()).program!.version, reward: 1 } }, 100, { balance: before.balance }), /must follow/, "spending without paying");
  await assert.rejects(forge(customer, { Redeem: { program: (await card()).program!.version, reward: 1 } }, 100, { balance: before.balance - 100 }, null), /latest entry/, "nor by starting over");
  console.log("[PASS] points can't be stated, earned twice, earned on another's order, gifted to oneself, or spent for free");

  // ===== Spending: on a reward they can have, once =====
  await assert.rejects(pickup([{ item_ref: soup, quantity: 1 }], 1000, 1), /doesn't apply/, "a free bread needs bread in the cart");
  await assert.rejects(pickup([{ item_ref: soup, quantity: 2 }], 1500, 2), /higher tier/, "Gold's reward needs Gold");
  const spent = await pickup([{ item_ref: soup, quantity: 1 }, { item_ref: bread, quantity: 1 }], 1000, 1);
  const spentRef = actionHash(spent);
  const redemption = decodeEntry<Order>(spent).rewards!.redemption;
  assert.ok(redemption, "the order cites what it spent");
  assert.equal(decodeEntry<Order>(spent).order_total, 1000, "the bread is free");
  assert.equal((await card()).balance, 230 - 100);
  // A second order citing the same redemption.
  const version = actionHash(await call(customer, "catalog")<HcRecord>("get_catalog", store));
  const raw = (rewardsField: unknown, total: number) =>
    call(customer, "dispatch")("create_raw_pickup_order_for_testing", {
      requester: customer.agentPubKey, merchant: merchant.agentPubKey, catalog_ref: store, catalog_version: version,
      lines: [{ item_ref: soup, priced_version: soup, quantity: 1, selections: [] }, { item_ref: bread, priced_version: bread, quantity: 1, selections: [] }],
      order_total: total, status: "Placed", requested_at: Date.now() * 1000, kitchen_note: null, promo_code_ref: null, bag_claim_ref: null,
      loyalty_proof: [], rewards: rewardsField, cancellation: null, ready_by: null, food_hold: null, sealed_customer_name: null,
    });
  const programVersion = decodeEntry<Order>(spent).rewards!.program;
  await assert.rejects(raw({ program: programVersion, redemption }, 1000), /pays for one order/, "a redemption pays for one order");
  await assert.rejects(raw({ program: programVersion, redemption: firstRef }, 1000), /customer's own/, "an order isn't a redemption");
  await assert.rejects(raw({ program: programVersion, redemption: null }, 1000), /promo code's requirement|lines at their priced versions/, "no discount without a redemption");
  const stolen = await call(stranger, "rewards")("create_raw_points_entry_for_testing", { catalog_ref: store, kind: { Redeem: { program: programVersion, reward: 1 } }, points: 100, state: { balance: 0, year: 2026, earned_this_year: 0, earned_last_year: 0, lifetime_earned: 0, orders: 0, first_earned_at: null, last_earned_at: null }, previous: null }).catch((e: Error) => e);
  assert.ok(stolen instanceof Error && /not enough points|must follow/.test(stolen.message), "nobody spends points they don't have");
  console.log("[PASS] a reward is spent on an order it applies to, at its tier, for its cost -- and pays for that one order only");

  // ===== Points spent on an order the store calls off come back =====
  await sync();
  await retryUntilOk(() => call(merchant, "dispatch")("decline_pickup_order", { order_original_action: spentRef, reason: "TooBusy" }));
  await sync();
  await retryUntil(() => call(merchant, "dispatch")("settle_order", spentRef).then(() => rewards(merchant)<ActionHash | null>("restore_for_order", spentRef)), (h) => !!h, 30, 1000);
  assert.equal(await rewards(merchant)("restore_for_order", spentRef), null, "once");
  await sync();
  await retryUntil(() => rewards(customer)<number>("collect_grants", null), (n) => n === 1, 30, 1000);
  assert.equal((await card()).balance, 230, "every point back");
  console.log("[PASS] points spent on an order the store calls off come back, from the store, once");

  // ===== The store's own grants, collected once; nobody grants another's =====
  const goodwill = await rewards(merchant)<ActionHash>("grant_points", { to: customer.agentPubKey, catalog_ref: store, points: 25, note: "Sorry about the wait" });
  await assert.rejects(rewards(stranger)("grant_points", { to: stranger.agentPubKey, catalog_ref: store, points: 1000, note: "" }), /store's owner/);
  await assert.rejects(rewards(stranger)("create_raw_points_grant_for_testing", { to: stranger.agentPubKey, catalog_ref: store, program: programVersion, points: 1000, reason: { Goodwill: { note: "" } } }), /only a store's owner/, "the network refuses it too");
  await sync();
  await retryUntil(() => rewards(customer)<number>("collect_grants", null), (n) => n === 1, 30, 1000);
  assert.equal((await card()).balance, 255);
  await assert.rejects(forge(customer, { Gift: { grant: goodwill } }, 25, { balance: 280 }), /collected once/);
  console.log("[PASS] a store's grant is its owner's, collected once");

  // ===== Unspent points come back only once nothing could use them =====
  const cardNow = await card();
  const lone = await rewards(customer)<ActionHash>("redeem", { catalog_ref: store, program: cardNow.program!.version, reward: 1 });
  assert.equal((await card()).balance, 155);
  await assert.rejects(forge(customer, { Unspend: { redemption: lone } }, 100, { balance: 255 }), /window has passed/, "not while an order could still cite it");
  await assert.rejects(forge(customer, { Unspend: { redemption: redemption! } }, 100, { balance: 255 }), /window has passed|paid for an order/, "nor one an order used");
  console.log("[PASS] a redemption comes back only once its window has passed with no order citing it");

  // ===== The store holds orders to its current program =====
  await rewards(merchant)("save_program", { ...program, earn: { ...program.earn, points_per_dollar: 1 } });
  await sync();
  const underOld = actionHash(await raw({ program: programVersion, redemption: null }, 1400) as HcRecord);
  await sync();
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: underOld }), /rewards program's earlier terms/, "an order citing a replaced version isn't accepted");
  const fresh = decodeEntry<Order>(await retryUntilOk(() => pickup([{ item_ref: soup, quantity: 1 }], 1000)));
  assert.ok(fresh.rewards && !bytesEqual(fresh.rewards.program, programVersion), "a new order cites the current version");
  console.log("[PASS] the store accepts only orders under its current program");
});
