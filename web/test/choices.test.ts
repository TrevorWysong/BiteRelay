import assert from "node:assert/strict";
import { test } from "node:test";
import { choiceLabels, choose, groupProblem, linePrice, missingGroups, type Groups } from "../src/lib/choices.ts";
import { bytesToHex } from "../src/holochain/decode.ts";
import type { MenuItem, ModifierGroup, ModifierOption, SelectionInput } from "../src/holochain/types.ts";

// The same cases as catalog_types::modifiers::tests -- keep them in step.
const hash = (n: number) => new Uint8Array(39).fill(n);
const STORE = hash(200);

function option(id: number, price_cents: number, nested_group: Uint8Array | null = null): ModifierOption {
  return { id, name: `option ${id}`, price_cents, available: true, nested_group };
}
function group(name: string, min: number, max: number | null, free: number, options: ModifierOption[]): ModifierGroup {
  return { catalog_ref: STORE, name, min_selections: min, max_selections: max, max_per_option: 1, free_selections: free, options };
}
function item(price_cents: number, groups: number[]): MenuItem {
  return { catalog_ref: STORE, name: "Latte", price_cents, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [], modifier_groups: groups.map(hash), tax_category: "" };
}
const menu = (entries: [number, ModifierGroup][]): Groups => new Map(entries.map(([n, g]) => [bytesToHex(hash(n)), g]));
const pick = (g: number, options: [number, number][]): SelectionInput => ({ group: hash(g), options: options.map(([option, quantity]) => ({ option, quantity, nested: [] })) });
const price = (p: ReturnType<typeof linePrice>) => (p.ok ? p.price : p.reason);

test("a required choice adds its price", () => {
  const groups = menu([[1, group("Size", 1, 1, 0, [option(1, 0), option(2, 75)])]]);
  assert.equal(price(linePrice(item(400, [1]), [pick(1, [[2, 1]])], groups)), 475);
  assert.equal(linePrice(item(400, [1]), [pick(1, [])], groups).ok, false);
  assert.equal(linePrice(item(400, [1]), [pick(1, [[1, 1], [2, 1]])], groups).ok, false);
});

test("every group is answered in order", () => {
  const groups = menu([
    [1, group("Size", 0, null, 0, [option(1, 0)])],
    [2, group("Milk", 0, null, 0, [option(1, 0)])],
  ]);
  assert.equal(price(linePrice(item(400, [1, 2]), [pick(1, []), pick(2, [])], groups)), 400);
  assert.equal(linePrice(item(400, [1, 2]), [pick(1, [])], groups).ok, false);
  assert.equal(linePrice(item(400, [1, 2]), [pick(2, []), pick(1, [])], groups).ok, false);
});

test("the cheapest choices are the free ones", () => {
  const groups = menu([[1, group("Toppings", 0, 4, 2, [option(1, 100), option(2, 50), option(3, 200)])]]);
  assert.equal(price(linePrice(item(1000, [1]), [pick(1, [[1, 1], [2, 1], [3, 1]])], groups)), 1200);
  assert.equal(price(linePrice(item(1000, [1]), [pick(1, [[3, 1]])], groups)), 1000);
});

test("an option chosen several times counts each", () => {
  const shots = { ...group("Extra shots", 0, 3, 0, [option(1, 80)]), max_per_option: 3 };
  const groups = menu([[1, shots]]);
  assert.equal(price(linePrice(item(400, [1]), [pick(1, [[1, 3]])], groups)), 640);
  assert.equal(linePrice(item(400, [1]), [pick(1, [[1, 4]])], groups).ok, false);
});

test("a nested choice is priced per unit of its option", () => {
  const groups = menu([
    [1, group("Side", 1, 1, 0, [option(1, 150, hash(2))])],
    [2, group("Size", 1, 1, 0, [option(1, 0), option(2, 100)])],
  ]);
  const nested: SelectionInput = { group: hash(1), options: [{ option: 1, quantity: 1, nested: [pick(2, [[2, 1]])] }] };
  assert.equal(price(linePrice(item(900, [1]), [nested], groups)), 1150);
  assert.equal(linePrice(item(900, [1]), [pick(1, [[1, 1]])], groups).ok, false);
  assert.deepEqual(choiceLabels([nested], groups), ["option 1 (option 2)"]);
});

test("choosing in a single-choice group replaces, and opens a nested group", () => {
  const size = group("Side", 1, 1, 0, [option(1, 0, hash(2)), option(2, 0)]);
  let s = choose(pick(1, []), size, 1, 1);
  assert.equal(bytesToHex(s.options[0].nested[0].group), bytesToHex(hash(2)));
  s = choose(s, size, 2, 1);
  assert.deepEqual(s.options.map((c) => c.option), [2]);
});

test("an item's sheet fetches its groups and those they open", () => {
  const groups = menu([[1, group("Side", 1, 1, 0, [option(1, 0, hash(2))])]]);
  assert.deepEqual(missingGroups(item(100, [1, 3]), groups).map(bytesToHex), [bytesToHex(hash(3)), bytesToHex(hash(2))]);
});

test("a group must make sense", () => {
  assert.equal(groupProblem(group("Size", 1, 1, 0, [option(1, 0)])), null);
  assert.notEqual(groupProblem(group("Size", 2, 1, 0, [option(1, 0), option(2, 0)])), null);
  assert.notEqual(groupProblem(group("Size", 3, null, 0, [option(1, 0), option(2, 0)])), null);
  assert.notEqual(groupProblem(group("Size", 0, 1, 2, [option(1, 0), option(2, 0)])), null);
  assert.notEqual(groupProblem(group("Size", 0, null, 0, [])), null);
});
