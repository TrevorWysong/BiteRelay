// Proves moving a store to its owner's new key, after they recovered their
// account onto it (their phone lost): the new key republishes
// it -- details, choice groups (nested ones too), menu and live promo
// codes, every reference remapped to the copies -- and records the move,
// which only the key that took over the store's owner can; each store
// moves once. Customers are sent on from the old store, and its ratings
// follow it. Forgeries are written raw (test-utils), as a modified client
// would.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, decodeEntry, phraseKey, phraseMessage, retryUntil, setupPlayersWithProperties, useTestCoordinators } from "./helpers.js";

interface View {
  original_action: Uint8Array;
  record: HcRecord;
}
interface Group {
  catalog_ref: Uint8Array;
  name: string;
  options: { id: number; name: string; nested_group: Uint8Array | null }[];
}
interface Item {
  catalog_ref: Uint8Array;
  name: string;
  price_cents: number;
  modifier_groups: Uint8Array[];
}

const same = (a: Uint8Array | null | undefined, b: Uint8Array) => !!a && Buffer.from(a).equals(Buffer.from(b));

await runScenario(async (scenario) => {
  const [alice, bob, carol] = await setupPlayersWithProperties(scenario, 3, () => ({ store_listing_stake: 0, credit_limit_cents: 0 }));
  const all = [alice, bob, carol];
  for (const p of all) await useTestCoordinators(p, ["catalog"]);
  const sync = () => dhtSync(all, alice.cells[0].cell_id[0]);
  const catalog = (p: typeof alice) => getZomeCaller(p.cells[0], "catalog");
  const account = (p: typeof alice) => getZomeCaller(p.cells[0], "account");

  // Alice's store: a combo whose side opens a fries-size choice, and a promo
  // giving the combo free.
  const published = await catalog(alice)<HcRecord>("publish_catalog", { business_name: "Alice's Diner", location: ST_PETE });
  const store = actionHash(published);
  const area = decodeEntry<{ geohash: string }>(published).geohash;
  const group = (name: string, options: unknown[]) => ({ catalog_ref: store, name, min_selections: 1, max_selections: 1, max_per_option: 1, free_selections: 0, options });
  const option = (id: number, name: string, nested_group: Uint8Array | null = null) => ({ id, name, price_cents: 0, available: true, nested_group });
  const fries = actionHash(await catalog(alice)<HcRecord>("create_modifier_group", group("Fries size", [option(1, "Regular"), option(2, "Large")])));
  const side = actionHash(await catalog(alice)<HcRecord>("create_modifier_group", group("Side", [option(1, "Fries", fries), option(2, "Salad")])));
  const combo = actionHash(
    await catalog(alice)<HcRecord>("add_menu_item", { catalog_ref: store, name: "Burger combo", price_cents: 900, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: ["halal"], modifier_groups: [side] }),
  );
  await catalog(alice)("create_promo_code", { catalog_ref: store, code: "FREECOMBO", requirement: "None", reward: { FreeItem: { item_ref: combo, quantity: 1 } }, expires_at: null, auto_apply: false });

  // ===== Alice loses her phone, and recovers her account onto Bob's key =====
  const phrase = phraseKey();
  const plan = await account(alice)<{ plan: Uint8Array }>("set_recovery_plan", { phrase_key: phrase.key, guardians: [], threshold: 0 });
  await sync();
  const head = await retryUntil(() => account(bob)<Uint8Array | null>("latest_action_of", alice.agentPubKey), (h) => !!h);
  await account(bob)("take_over", { predecessor: alice.agentPubKey, authority: { Phrase: { plan: plan.plan, head, signature: phrase.sign(phraseMessage(alice.agentPubKey, bob.agentPubKey, head!)) } } });
  await sync();

  await assert.rejects(catalog(carol)("move_store", store), /hasn't taken over an account/, "only a key that took over an account moves its stores");
  const stores = await retryUntil(() => catalog(bob)<View[]>("catalogs_of", alice.agentPubKey), (list) => list.length === 1);
  assert.ok(same(stores[0].original_action, store), "the new key sees the stores the account ran");
  const moved = await catalog(bob)<Uint8Array>("move_store", store);
  assert.deepEqual(await catalog(bob)<Uint8Array>("move_store", store), moved, "safe to repeat: one new store");
  console.log("[PASS] the account's new key moves its store, once");

  // ===== A faithful copy, every reference remapped =====
  const copy = decodeEntry<{ owner: Uint8Array; business_name: string; dietary_tags: string[] }>(await catalog(bob)<HcRecord>("get_catalog", moved));
  assert.ok(same(copy.owner, bob.agentPubKey) && copy.business_name === "Alice's Diner");
  assert.deepEqual(copy.dietary_tags, ["halal"], "its tags recomputed from the copied menu");
  const [item] = (await catalog(bob)<{ items: View[] }>("list_menu_items", { catalog_ref: moved, after: null })).items.map((v) => ({ ref: v.original_action, ...decodeEntry<Item>(v.record) }));
  assert.equal(item.name, "Burger combo");
  assert.ok(same(item.catalog_ref, moved));
  const groups = (await catalog(bob)<View[]>("list_modifier_groups", moved)).map((v) => ({ ref: v.original_action, ...decodeEntry<Group>(v.record) }));
  const newSide = groups.find((g) => g.name === "Side")!;
  const newFries = groups.find((g) => g.name === "Fries size")!;
  assert.ok(same(item.modifier_groups[0], newSide.ref), "the item offers the copied group");
  assert.ok(same(newSide.options[0].nested_group, newFries.ref), "which opens the copied nested group");
  assert.ok(!same(newSide.ref, side) && !same(newFries.ref, fries));
  const [promo] = (await catalog(bob)<View[]>("list_live_promo_codes", moved)).map((v) => decodeEntry<{ code: string; reward: { FreeItem: { item_ref: Uint8Array } } }>(v.record));
  assert.equal(promo.code, "FREECOMBO");
  assert.ok(same(promo.reward.FreeItem.item_ref, item.ref), "the promo names the copied item");
  console.log("[PASS] the new store copies the old faithfully, references and all");

  // ===== Everyone is sent on; its history follows =====
  await sync();
  const successor = await retryUntil(() => catalog(carol)<Uint8Array | null>("store_successor", store), (s) => !!s);
  assert.ok(same(successor, moved), "a customer opening the old store is sent to the new one");
  const line = await catalog(carol)<Uint8Array[]>("store_line", moved);
  assert.ok(line.length === 1 && same(line[0], store), "and the new store's ratings include the old one's");
  await catalog(bob)("reopen_listing", moved);
  await sync();
  const nearby = await retryUntil(
    () => catalog(carol)<{ catalogs: View[] }>("get_nearby_merchants", { geohash: area, after: null }).then((p) => p.catalogs),
    (list) => list.some((c) => same(c.original_action, moved)),
  );
  assert.ok(!nearby.some((c) => same(c.original_action, store)), "only the new store is listed");
  console.log("[PASS] customers find the new store, and the old one leads to it");

  // ===== Forgeries =====
  const bobsSuccession = (await account(bob)<{ succession: Uint8Array }>("my_succession", null)).succession;
  const carolsStore = actionHash(await catalog(carol)<HcRecord>("publish_catalog", { business_name: "Carol's", location: ST_PETE }));
  await assert.rejects(
    catalog(carol)("create_raw_store_move_for_testing", { from: store, to: carolsStore, succession: bobsSuccession }),
    /only the key that took over/,
    "nobody else can claim a store moved to them",
  );
  const another = actionHash(await catalog(bob)<HcRecord>("publish_catalog", { business_name: "Bob's second", location: ST_PETE }));
  await sync();
  await assert.rejects(catalog(bob)("create_raw_store_move_for_testing", { from: store, to: another, succession: bobsSuccession }), /moves once/, "a store moves once");
  await assert.rejects(catalog(bob)("create_raw_store_move_for_testing", { from: carolsStore, to: another, succession: bobsSuccession }), /only the key that took over/, "and only a store of the account taken over");
  console.log("[PASS] a store's move can't be forged");
});
