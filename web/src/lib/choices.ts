// Menu item choices -- sizes, add-ons, sides -- on the customer's side: what
// a line costs with its choices, whether they're complete, how they read,
// and how picking an option changes them. The pricing mirrors
// `catalog_types::modifiers::line_price`, which validation enforces, so the
// running price on the item sheet is what the order is charged; both are
// tested on the same cases (web/test/choices.test.ts).
import type { ActionHash, ChosenInput, MenuItem, ModifierGroup, SelectionInput } from "../holochain/types";
import { MAX_CHOICE_DEPTH, MAX_LINE_CHOICES } from "../holochain/types";
import { bytesToHex } from "../holochain/decode";
import { t } from "../i18n";

/// A store's choice groups at their latest, by original action (hex).
export type Groups = Map<string, ModifierGroup>;

export type Priced = { ok: true; price: number } | { ok: false; reason: string };

/// What one unit of `item` costs with `selections`, or why they don't fit
/// -- one per item group in order, options ascending and on offer, each
/// group's count within its bounds, nested groups answered, the cheapest
/// `free_selections` of each group free.
export function linePrice(item: MenuItem, selections: SelectionInput[], groups: Groups): Priced {
  const budget = { left: MAX_LINE_CHOICES };
  const choices = priceSelections(item.modifier_groups, selections, groups, 1, budget);
  return choices.ok ? { ok: true, price: item.price_cents + choices.price } : choices;
}

function priceSelections(refs: ActionHash[], selections: SelectionInput[], groups: Groups, depth: number, budget: { left: number }): Priced {
  if (selections.length !== refs.length || selections.some((s, i) => bytesToHex(s.group) !== bytesToHex(refs[i]))) {
    return { ok: false, reason: t("choices.chooseEach") };
  }
  let total = 0;
  for (const selection of selections) {
    const group = groups.get(bytesToHex(selection.group));
    if (!group) return { ok: false, reason: t("choices.changed") };
    const priced = priceGroup(group, selection, groups, depth, budget);
    if (!priced.ok) return priced;
    total += priced.price;
  }
  return { ok: true, price: total };
}

function priceGroup(group: ModifierGroup, selection: SelectionInput, groups: Groups, depth: number, budget: { left: number }): Priced {
  const units: number[] = [];
  let nestedCost = 0;
  let previous = -1;
  for (const chosen of selection.options) {
    if (chosen.option <= previous) return { ok: false, reason: t("choices.once", { group: group.name }) };
    previous = chosen.option;
    if (budget.left === 0) return { ok: false, reason: t("choices.atMost", { count: MAX_LINE_CHOICES }) };
    budget.left -= 1;
    const option = group.options.find((o) => o.id === chosen.option && o.available);
    if (!option) return { ok: false, reason: t("choices.gone", { group: group.name }) };
    if (chosen.quantity < 1 || chosen.quantity > group.max_per_option) return { ok: false, reason: t("choices.perOption", { option: option.name, max: group.max_per_option }) };
    for (let i = 0; i < chosen.quantity; i++) units.push(option.price_cents);
    if (option.nested_group) {
      if (depth >= MAX_CHOICE_DEPTH) return { ok: false, reason: t("choices.tooDeep") };
      const nested = priceSelections([option.nested_group], chosen.nested, groups, depth + 1, budget);
      if (!nested.ok) return nested;
      nestedCost += nested.price * chosen.quantity;
    } else if (chosen.nested.length > 0) {
      return { ok: false, reason: t("choices.nothingMore", { option: option.name }) };
    }
  }
  const count = units.length;
  if (count < group.min_selections || (group.max_selections !== null && count > group.max_selections)) {
    return { ok: false, reason: t("choices.range", { group: group.name, range: rangeLabel(group) }) };
  }
  units.sort((a, b) => a - b);
  const charged = units.slice(group.free_selections).reduce((sum, p) => sum + p, 0);
  return { ok: true, price: charged + nestedCost };
}

/// "Choose 1", "Choose up to 3", "Choose 2 to 4" -- what a group asks for.
export function rangeLabel(group: ModifierGroup): string {
  const { min_selections: min, max_selections: max } = group;
  if (max !== null && min === max) return t("choices.exactly", { count: max });
  if (min === 0) return max === null ? t("choices.any") : t("choices.upTo", { count: max });
  return max === null ? t("choices.atLeast", { count: min }) : t("choices.between", { min, max });
}

/// Whether a group takes one option only -- shown as radio buttons.
export function isSingleChoice(group: ModifierGroup): boolean {
  return group.max_selections === 1 && group.max_per_option === 1;
}

/// A fresh, empty answer for each of `refs`.
export function emptySelections(refs: ActionHash[]): SelectionInput[] {
  return refs.map((group) => ({ group, options: [] }));
}

/// `selection` with `optionId` chosen `quantity` times (0 removes it) --
/// replacing the choice in a single-choice group, opening an empty answer
/// for the option's nested group, and keeping options ascending.
export function choose(selection: SelectionInput, group: ModifierGroup, optionId: number, quantity: number): SelectionInput {
  const option = group.options.find((o) => o.id === optionId);
  if (!option) return selection;
  const existing = selection.options.find((c) => c.option === optionId);
  const kept = isSingleChoice(group) ? [] : selection.options.filter((c) => c.option !== optionId);
  const next: ChosenInput[] =
    quantity > 0 ? [...kept, { option: optionId, quantity, nested: existing?.nested ?? (option.nested_group ? emptySelections([option.nested_group]) : []) }] : kept;
  return { ...selection, options: next.sort((a, b) => a.option - b.option) };
}

/// `selection` with the nested answer under `optionId` replaced.
export function withNested(selection: SelectionInput, optionId: number, nested: SelectionInput): SelectionInput {
  return { ...selection, options: selection.options.map((c) => (c.option === optionId ? { ...c, nested: [nested] } : c)) };
}

/// Every chosen option, as people read them: "Large", "2 x Extra shot",
/// "Fries (Large)" -- the same wording as the order's lines.
export function choiceLabels(selections: SelectionInput[], groups: Groups): string[] {
  return selections.flatMap((selection) => {
    const group = groups.get(bytesToHex(selection.group));
    return selection.options.map((chosen) => {
      const name = group?.options.find((o) => o.id === chosen.option)?.name ?? "(removed)";
      const label = chosen.quantity > 1 ? `${chosen.quantity} x ${name}` : name;
      const nested = choiceLabels(chosen.nested, groups);
      return nested.length ? `${label} (${nested.join(", ")})` : label;
    });
  });
}

/// The groups an item's sheet needs beyond those already in `groups`: its
/// own, and any its options open, `MAX_CHOICE_DEPTH` levels down.
export function missingGroups(item: MenuItem, groups: Groups): ActionHash[] {
  const missing = new Map<string, ActionHash>();
  let level = item.modifier_groups;
  for (let depth = 1; depth <= MAX_CHOICE_DEPTH && level.length > 0; depth++) {
    const next: ActionHash[] = [];
    for (const ref of level) {
      const group = groups.get(bytesToHex(ref));
      if (!group) missing.set(bytesToHex(ref), ref);
      else next.push(...group.options.flatMap((o) => (o.nested_group ? [o.nested_group] : [])));
    }
    level = next;
  }
  return [...missing.values()];
}

/// A stable key for a set of choices -- two cart lines with the same item
/// and key are one line.
export function selectionsKey(selections: SelectionInput[]): string {
  return selections.map((s) => `${bytesToHex(s.group)}[${s.options.map((c) => `${c.option}x${c.quantity}${c.nested.length ? `{${selectionsKey(c.nested)}}` : ""}`).join(",")}]`).join(";");
}

/// What a store's group form would be refused for, if anything -- the
/// network's rules (`ModifierGroup::problem`), told first.
export function groupProblem(group: ModifierGroup): string | null {
  if (!group.name.trim()) return t("choices.problem.name");
  if (group.options.length === 0) return t("choices.problem.noOptions");
  if (group.options.some((o) => !o.name.trim())) return t("choices.problem.optionName");
  if (new Set(group.options.map((o) => o.id)).size !== group.options.length) return t("choices.problem.ids");
  const most = group.options.length * group.max_per_option;
  if (group.min_selections > most) return t("choices.problem.minTooHigh");
  if (group.max_selections !== null && (group.max_selections < 1 || group.max_selections < group.min_selections || group.max_selections > most)) {
    return t("choices.problem.max");
  }
  if (group.free_selections > (group.max_selections ?? most)) return t("choices.problem.free");
  return null;
}
