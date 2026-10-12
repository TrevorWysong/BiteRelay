// Menu item choices -- sizes, add-ons, nested sides -- as DoorDash and Uber
// Eats have them, and the rules no client can get around:
//
// - an order's choices must fit the item's groups: every required group
//   answered, within its limits, from options on offer, from the item's
//   own store;
// - each line's price is recomputed from the group versions it names, the
//   cheapest free choices free, so a forged total is refused;
// - the same item may be on several lines with different choices, and a
//   missing-item report is worth its own line's price;
// - a store refuses an order priced from choices it has since changed.
//
// Orders written raw (create_raw_pickup_order_for_testing) are what a
// modified client could do: every refusal of one comes from validation.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, retryUntil, retryUntilOk, ST_PETE, useTestCoordinators, testApp } from "./helpers.js";

interface LineView {
  name: string;
  quantity: number;
  unit_price_cents: number;
  choices: string[];
}
interface IssueView {
  value: number;
}

const option = (id: number, name: string, price_cents: number, extra: Record<string, unknown> = {}) => ({ id, name, price_cents, available: true, nested_group: null, ...extra });

await runScenario(async (scenario) => {
  const [customer, merchant, rival] = await scenario.addPlayersWithApps([testApp, testApp, testApp]);
  const all = [customer, merchant, rival];
  await scenario.shareAllAgents();
  for (const player of all) await useTestCoordinators(player, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(rival, "profiles")("create_profile", { display_name: "Rae", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's Coffee", location: ST_PETE }));
  const rivalStore = actionHash(await call(rival, "catalog")<HcRecord>("publish_catalog", { business_name: "Rae's", location: ST_PETE }));

  // ===== The store's choices =====
  const group = (catalog_ref: Uint8Array, name: string, min: number, max: number | null, options: unknown[], extra: Record<string, unknown> = {}) => ({
    catalog_ref,
    name,
    min_selections: min,
    max_selections: max,
    max_per_option: 1,
    free_selections: 0,
    options,
    ...extra,
  });
  const sizeGroup = group(store, "Size", 1, 1, [option(1, "Small", 0), option(2, "Large", 75)]);
  const size = actionHash(await call(merchant, "catalog")<HcRecord>("create_modifier_group", sizeGroup));
  const shots = actionHash(
    await call(merchant, "catalog")<HcRecord>("create_modifier_group", group(store, "Extras", 0, 3, [option(1, "Extra shot", 80), option(2, "Vanilla", 50, { available: false })], { max_per_option: 3, free_selections: 1 })),
  );
  const friesSize = actionHash(await call(merchant, "catalog")<HcRecord>("create_modifier_group", group(store, "Fries size", 1, 1, [option(1, "Regular", 0), option(2, "Large", 100)])));
  const side = actionHash(await call(merchant, "catalog")<HcRecord>("create_modifier_group", group(store, "Side", 1, 1, [option(1, "Fries", 150, { nested_group: friesSize }), option(2, "Salad", 200)])));
  const rivalGroup = actionHash(await call(rival, "catalog")<HcRecord>("create_modifier_group", group(rivalStore, "Size", 0, 1, [option(1, "Huge", 0)])));
  await sync();

  await assert.rejects(
    call(merchant, "catalog")("create_modifier_group", group(store, "Broken", 2, 1, [option(1, "A", 0), option(2, "B", 0)])),
    /at least its minimum/,
    "a group whose limits can't be met is refused",
  );
  await assert.rejects(
    call(merchant, "catalog")("create_modifier_group", group(store, "Borrowed", 0, 1, [option(1, "A", 0, { nested_group: rivalGroup })])),
    /same store's choice groups/,
    "an option can't open another store's group",
  );
  await sync();

  const latte = { catalog_ref: store, name: "Latte", price_cents: 400, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [], modifier_groups: [size, shots] };
  const latteRef = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", latte));
  const comboRef = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { ...latte, name: "Burger combo", price_cents: 900, modifier_groups: [side] }));
  await assert.rejects(
    call(merchant, "catalog")("add_menu_item", { ...latte, name: "Stolen", modifier_groups: [rivalGroup] }),
    /its own store's/,
    "an item can't offer another store's group",
  );
  await sync();
  console.log("[PASS] a store's choice groups are its own, and must make sense");

  // ===== Ordering with choices =====
  const pick = (g: Uint8Array, options: [number, number][]) => ({ group: g, options: options.map(([o, quantity]) => ({ option: o, quantity, nested: [] })) });
  const largeTwoShots = [pick(size, [[2, 1]]), pick(shots, [[1, 2]])];
  const plainSmall = [pick(size, [[1, 1]]), pick(shots, [])];
  const friesLarge = [{ group: side, options: [{ option: 1, quantity: 1, nested: [pick(friesSize, [[2, 1]])] }] }];
  // Large (+75), two shots with one free (+80); two small lattes; a combo
  // with large fries (+150 +100).
  const total = 400 + 75 + 80 + 2 * 400 + (900 + 150 + 100);
  const order = actionHash(
    await retryUntilOk(() =>
      call(customer, "dispatch")<HcRecord>("request_pickup_order", {
        merchant: merchant.agentPubKey,
        catalog_ref: store,
        items: [
          { item_ref: latteRef, quantity: 1, selections: largeTwoShots },
          { item_ref: latteRef, quantity: 2, selections: plainSmall },
          { item_ref: comboRef, quantity: 1, selections: friesLarge },
        ],
        order_total: total,
      }),
    ),
  );
  await sync();
  const lines = await call(merchant, "dispatch")<LineView[]>("get_order_lines", order);
  assert.deepEqual(
    lines.map((l) => [l.name, l.quantity, l.unit_price_cents, l.choices]),
    [
      ["Latte", 1, 555, ["Large", "2 x Extra shot"]],
      ["Latte", 2, 400, ["Small"]],
      ["Burger combo", 1, 1150, ["Fries (Large)"]],
    ],
    "the kitchen reads each line with its choices and what it cost",
  );
  await assert.rejects(
    call(customer, "dispatch")("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: latteRef, quantity: 1, selections: [pick(size, [[1, 1]]), pick(shots, [[2, 1]])] }], order_total: 450 }),
    /isn't on offer/,
    "a sold-out choice can't be ordered",
  );
  console.log("[PASS] an order with choices is priced from them, the cheapest free ones free");

  // ===== What a modified client can't do =====
  // Priced at each group's first version -- its current one, until the
  // store changes it below.
  type Picked = { group: Uint8Array; options: { option: number; quantity: number; nested: Picked[] }[] };
  const versioned = (selections: Picked[]): unknown[] => selections.map((s) => ({ group: s.group, version: s.group, options: s.options.map((c) => ({ ...c, nested: versioned(c.nested) })) }));
  const raw = async (selections: Picked[], order_total: number, extra: Record<string, unknown> = {}) =>
    call(customer, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: customer.agentPubKey,
      merchant: merchant.agentPubKey,
      catalog_ref: store,
      catalog_version: store,
      lines: [{ item_ref: latteRef, priced_version: latteRef, quantity: 1, selections: versioned(selections) }],
      order_total,
      status: "Placed",
      requested_at: Date.now() * 1000,
      kitchen_note: null,
      promo_code_ref: null,
      bag_claim_ref: null,
      loyalty_proof: [],
      ...extra,
    });

  await raw(largeTwoShots, 555);
  await assert.rejects(raw(largeTwoShots, 475), /order_total must be 555/, "a total that skips a paid choice is refused");
  await assert.rejects(raw([pick(shots, [])], 400), /each of its item's choice groups/, "a required group can't be skipped");
  await assert.rejects(raw([pick(size, []), pick(shots, [])], 400), /Size: choose exactly 1/, "nor answered with nothing");
  await assert.rejects(raw([pick(size, [[1, 1], [2, 1]]), pick(shots, [])], 475), /Size: choose exactly 1/, "nor with two sizes");
  await assert.rejects(raw([pick(size, [[1, 1]]), pick(shots, [[1, 4]])], 640), /between 1 and 3 times/, "an option can't be chosen past its limit");
  await assert.rejects(raw([pick(size, [[1, 1]]), pick(shots, [[2, 1]])], 400), /isn't on offer/, "a sold-out option can't be chosen");
  await assert.rejects(raw([pick(size, [[1, 1]]), pick(rivalGroup, [])], 400), /each of its item's choice groups/, "another store's group can't stand in");
  await assert.rejects(
    raw(plainSmall, 800, {
      lines: [
        { item_ref: latteRef, priced_version: latteRef, quantity: 1, selections: versioned(plainSmall) },
        { item_ref: latteRef, priced_version: latteRef, quantity: 1, selections: versioned(plainSmall) },
      ],
    }),
    /same choices is one line/,
    "the same item with the same choices is one line",
  );
  console.log("[PASS] validation refuses choices that don't fit, and any total but theirs");

  // ===== A changed choice group =====
  // The store raises Large; an order placed afterwards, priced from the old
  // version, is one validation can't tell from current -- the store can.
  await call(merchant, "catalog")("update_modifier_group", { original_action: size, group: { ...sizeGroup, options: [option(1, "Small", 0), option(2, "Large", 125)] } });
  await sync();
  const stale = actionHash(await raw(largeTwoShots, 555));
  await sync();
  await assert.rejects(call(merchant, "dispatch")("accept_pickup_order", { order_original_action: stale }), /Size was priced from an outdated menu/, "the store refuses an order priced from changed choices");
  await retryUntilOk(() =>
    call(customer, "dispatch")("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: latteRef, quantity: 1, selections: largeTwoShots }], order_total: 605 }),
  );
  console.log("[PASS] a store's changed choices price new orders, and it refuses old prices");

  // ===== A report is worth its line =====
  await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order }));
  await call(merchant, "dispatch")("mark_ready_for_pickup", order);
  await sync();
  await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", order), 40);
  await sync();
  await call(customer, "dispatch")("report_issue", { order, lines: [{ line: 0, quantity: 1, kind: "Wrong" }], note: "Got a small", photo_data_uri: "" });
  await sync();
  const issues = await retryUntil(() => call(merchant, "dispatch")<IssueView[]>("get_issues_for_order", order), (found) => found.length === 1);
  assert.equal(issues[0].value, 555, "the large latte with its shots is refunded at its own price, not a plain one's");
  console.log("[PASS] a missing-item report is worth its own line, choices included");
});
