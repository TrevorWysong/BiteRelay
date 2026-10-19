// An item's choices, as DoorDash and Uber Eats show them: the item's photo,
// name and price, then each choice group in turn -- radio buttons when it
// takes one option, checkboxes or a "+" that grows into a stepper otherwise,
// on the right of each option with its price under its name -- with
// "Required" on the groups that need an answer and nested groups opening
// under the option that leads to them. Adding before every required group
// is answered scrolls to the first one that isn't and marks it. The running
// price is the network's own (`lib/choices`), so it's what the order costs.
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Minus, Plus } from "lucide-react";
import { getModifierGroups } from "../holochain/zomes/catalog";
import { bytesToHex, decodeEntry } from "../holochain/decode";
import type { ActionHash, ModifierGroup, SelectionInput } from "../holochain/types";
import { MAX_CHOICE_DEPTH } from "../holochain/types";
import { choiceLabels, choose, emptySelections, isSingleChoice, linePrice, missingGroups, rangeLabel, withNested, type Groups } from "../lib/choices";
import { formatCents } from "../lib/format";
import type { ItemRow } from "../lib/menu";
import { useResource } from "../lib/useResource";
import type { CartLine } from "../store/cart";
import { Button, Skeleton } from "./ui";
import { Sheet } from "./Sheet";
import { useT } from "../i18n";

/// An item's groups and every group they open, at their latest.
async function fetchItemGroups(catalogRef: ActionHash, row: ItemRow): Promise<Groups> {
  const groups: Groups = new Map();
  for (let depth = 0; depth < MAX_CHOICE_DEPTH; depth++) {
    const missing = missingGroups(row.item, groups);
    if (missing.length === 0) break;
    for (const view of await getModifierGroups(catalogRef, missing)) groups.set(bytesToHex(view.original_action), decodeEntry<ModifierGroup>(view.record));
  }
  return groups;
}

export function ItemSheet({ catalogRef, row, editing, onClose, onDone }: { catalogRef: ActionHash; row: ItemRow; editing?: CartLine; onClose: () => void; onDone: (line: CartLine) => void }) {
  const t = useT();
  const { item } = row;
  const { data: groups, error } = useResource(`item-groups:${bytesToHex(row.version)}`, () => fetchItemGroups(catalogRef, row));
  const [selections, setSelections] = useState<SelectionInput[]>(editing?.selections ?? emptySelections(item.modifier_groups));
  const [quantity, setQuantity] = useState(editing?.quantity ?? 1);
  /// Whether the customer has tried to add it -- unanswered groups are
  /// marked from then on.
  const [attempted, setAttempted] = useState(false);

  const priced = groups ? linePrice(item, selections, groups) : null;
  const unit = priced?.ok ? priced.price : item.price_cents;

  function done(event: React.MouseEvent<HTMLButtonElement>) {
    if (!groups) return;
    if (!priced?.ok) {
      setAttempted(true);
      // The first group still waiting for an answer, nested ones included.
      event.currentTarget.closest("[role=dialog]")?.querySelector("[data-unanswered=true]")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    onDone({ itemRef: row.hash, name: item.name, basePriceCents: item.price_cents, priceCents: priced.price, quantity, selections, choiceLabels: choiceLabels(selections, groups) });
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={item.name}
      footer={
        <div className="flex items-center gap-3">
          <Stepper value={quantity} min={1} max={99} onChange={setQuantity} />
          <Button className="flex-1" disabled={!groups} onClick={done}>
            {editing ? t("item.update") : t("item.add")} · {formatCents(unit * quantity)}
          </Button>
        </div>
      }
    >
      {item.photo_data_uri && <img src={item.photo_data_uri} alt="" className="-mx-5 -mt-3 mb-4 aspect-[16/9] w-[calc(100%+2.5rem)] max-w-none object-cover" />}
      <p className="text-base font-semibold tabular-nums text-ink-900 dark:text-ink-50">{formatCents(item.price_cents)}</p>
      {item.description && <p className="mt-1 text-sm leading-relaxed text-ink-500 dark:text-ink-400">{item.description}</p>}
      {error ? <p className="mt-4 text-sm text-red-600 dark:text-red-400">{t("item.loadFailed")}</p> : null}
      {!groups && !error && (
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}
      {groups && (
        <div className="mt-2 flex flex-col">
          {selections.map((selection, i) => {
            const group = groups.get(bytesToHex(selection.group));
            return group ? (
              <GroupPicker key={bytesToHex(selection.group)} group={group} groups={groups} selection={selection} attempted={attempted} onChange={(next) => setSelections((all) => all.map((s, j) => (j === i ? next : s)))} />
            ) : null;
          })}
        </div>
      )}
    </Sheet>
  );
}

function GroupPicker({
  group,
  groups,
  selection,
  attempted,
  onChange,
  nested = false,
}: {
  group: ModifierGroup;
  groups: Groups;
  selection: SelectionInput;
  attempted: boolean;
  onChange: (next: SelectionInput) => void;
  nested?: boolean;
}) {
  const count = selection.options.reduce((n, c) => n + c.quantity, 0);
  const required = group.min_selections > 0;
  const t = useT();
  const full = group.max_selections !== null && count >= group.max_selections;
  const met = count >= group.min_selections;
  const missing = attempted && !met;
  const single = isSingleChoice(group);
  const stepper = group.max_per_option > 1;

  return (
    <section data-unanswered={!met} className={nested ? "mb-1 mt-1 rounded-2xl bg-ink-50 px-3 pt-3 dark:bg-ink-800/50" : "border-t border-ink-100 pt-5 first:border-t-0 dark:border-ink-800 [&:not(:first-child)]:mt-5"}>
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <h3 className={`font-bold text-ink-900 dark:text-ink-50 ${nested ? "text-sm" : "text-base"}`}>{group.name}</h3>
          <p className={`text-xs ${missing ? "font-semibold text-red-600 dark:text-red-400" : "text-ink-400"}`}>
            {rangeLabel(group).replace(/^./, (c) => c.toUpperCase())}
            {group.free_selections > 0 && ` · ${t("item.free", { count: group.free_selections })}`}
          </p>
        </div>
        {required && (
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              met ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200" : missing ? "bg-red-600 text-white" : "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300"
            }`}
          >
            {met && <Check size={12} />}
            {t("item.required")}
          </span>
        )}
      </div>
      <ul className="flex flex-col">
        {group.options.map((option) => {
          const chosen = selection.options.find((c) => c.option === option.id);
          const units = chosen?.quantity ?? 0;
          const blocked = !option.available || (!chosen && full && !single);
          const nestedGroup = option.nested_group ? groups.get(bytesToHex(option.nested_group)) : undefined;
          // A required single choice is changed by picking another; an
          // optional one can also be unticked.
          const toggle = () => onChange(choose(selection, group, option.id, units > 0 && (!single || !required) ? 0 : 1));
          const label = (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] text-ink-900 dark:text-ink-50">{option.name}</span>
              {(option.price_cents > 0 || !option.available) && (
                <span className="block text-xs tabular-nums text-ink-500 dark:text-ink-400">{option.available ? `+${formatCents(option.price_cents)}` : t("item.soldOut")}</span>
              )}
            </span>
          );
          return (
            <li key={option.id} className="border-b border-ink-100 last:border-b-0 dark:border-ink-800">
              {stepper ? (
                <div className={`flex min-h-14 items-center gap-3 py-2 ${blocked && !chosen ? "opacity-40" : ""}`}>
                  {label}
                  {option.available && <CompactStepper value={units} max={full ? units : group.max_per_option} label={option.name} onChange={(q) => onChange(choose(selection, group, option.id, q))} />}
                </div>
              ) : (
                <button
                  type="button"
                  role={single ? "radio" : "checkbox"}
                  aria-checked={units > 0}
                  disabled={blocked && !chosen}
                  onClick={toggle}
                  className={`flex min-h-14 w-full items-center gap-3 py-2 text-left ${blocked && !chosen ? "opacity-40" : ""}`}
                >
                  {label}
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center border-2 transition ${single ? "rounded-full" : "rounded-md"} ${
                      units > 0 ? "border-relay-500 bg-relay-500 text-white" : "border-ink-300 dark:border-ink-600"
                    }`}
                  >
                    {units > 0 && (single ? <span className="h-2.5 w-2.5 rounded-full bg-white" /> : <Check size={14} strokeWidth={3} />)}
                  </span>
                </button>
              )}
              <AnimatePresence initial={false}>
                {chosen && nestedGroup && chosen.nested[0] && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden pb-3">
                    <GroupPicker nested group={nestedGroup} groups={groups} selection={chosen.nested[0]} attempted={attempted} onChange={(inner) => onChange(withNested(selection, option.id, inner))} />
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/// A "+" until the option's chosen, then "- n +" -- as DoorDash shows an
/// option that can be added more than once.
function CompactStepper({ value, max, label, onChange }: { value: number; max: number; label: string; onChange: (value: number) => void }) {
  const t = useT();
  const button = "grid h-8 w-8 place-items-center rounded-full transition disabled:opacity-30";
  if (value === 0) {
    return (
      <button type="button" aria-label={t("store.add", { item: label })} disabled={max === 0} className={`${button} border border-ink-200 text-ink-900 hover:bg-ink-100 dark:border-ink-700 dark:text-ink-50 dark:hover:bg-ink-800`} onClick={() => onChange(1)}>
        <Plus size={16} />
      </button>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-1 rounded-full bg-ink-100 p-0.5 dark:bg-ink-800">
      <button type="button" aria-label={t("item.fewerOf", { item: label })} className={`${button} text-ink-700 hover:bg-white dark:text-ink-200 dark:hover:bg-ink-700`} onClick={() => onChange(value - 1)}>
        <Minus size={15} />
      </button>
      <span className="w-5 text-center text-sm font-bold tabular-nums text-ink-900 dark:text-ink-50">{value}</span>
      <button type="button" aria-label={t("item.moreOf", { item: label })} className={`${button} text-ink-700 hover:bg-white dark:text-ink-200 dark:hover:bg-ink-700`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Plus size={15} />
      </button>
    </div>
  );
}

function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (value: number) => void }) {
  const t = useT();
  const button = "grid h-9 w-9 place-items-center rounded-full transition disabled:opacity-30 text-ink-700 hover:bg-white dark:text-ink-200 dark:hover:bg-ink-700";
  return (
    <div className="flex shrink-0 items-center gap-1 rounded-full bg-ink-100 p-0.5 dark:bg-ink-800">
      <button type="button" aria-label={t("item.fewer")} className={button} disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Minus size={16} />
      </button>
      <span className="w-6 text-center text-sm font-bold tabular-nums text-ink-900 dark:text-ink-50">{value}</span>
      <button type="button" aria-label={t("item.more")} className={button} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Plus size={16} />
      </button>
    </div>
  );
}
