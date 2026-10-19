import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { addMenuItem, updateMenuItem } from "../../../holochain/zomes/catalog";
import { bytesToHex, hexToBytes } from "../../../holochain/decode";
import { groupByCategory, type ItemRow } from "../../../lib/menu";
import { formatCents, toMinorUnits, fromMinorUnits, currencySymbol } from "../../../lib/format";
import { fadeSlideUp, staggerContainer } from "../../../lib/motion";
import { Button, Card, Checkbox, Field, Input, Select, StatNumber, Textarea } from "../../../components/ui";
import { useTerms } from "../../../store/network";
import { percentLabel } from "../../../lib/tax";
import { PhotoInput } from "../../../components/PhotoInput";
import { MAX_DESCRIPTION_CHARS, MAX_ITEM_GROUPS, MAX_LABEL_CHARS, MAX_NAME_CHARS, type TaxRate } from "../../../holochain/types";
import { Check } from "lucide-react";
import type { GroupRow } from "./ChoicesSection";
import { useT } from "../../../i18n";

/// What the editor is open for: a new item, an existing one, or nothing.
type Editing = { kind: "new" } | { kind: "edit"; row: ItemRow } | null;

/// The store's menu, grouped by category, with an add/edit form. Changes go
/// through `onChanged`, which reloads the menu (the promo form reads it too).
export function MenuSection({ catalogRef, items, groups, taxRates, onChanged }: { catalogRef: Uint8Array; items: ItemRow[]; groups: GroupRow[]; taxRates: TaxRate[]; onChanged: () => Promise<void> }) {
  const t = useT();
  const [editing, setEditing] = useState<Editing>(null);
  const grouped = groupByCategory(items);

  async function toggleAvailable(row: ItemRow) {
    await updateMenuItem(row.hash, { ...row.item, available: !row.item.available });
    await onChanged();
  }

  return (
    <>
      <motion.div variants={fadeSlideUp} className="mb-3 flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-400">{t("nav.menu")}</p>
        <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => setEditing(editing ? null : { kind: "new" })}>
          <Plus size={14} /> {editing ? t("common.cancel") : t("menuEditor.add")}
        </Button>
      </motion.div>

      <AnimatePresence initial={false}>
        {editing && (
          // Keyed by what's being edited, so switching items mounts a fresh
          // form seeded from that item instead of copying it into state.
          <motion.div key={editing.kind === "edit" ? bytesToHex(editing.row.hash) : "new"} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <ItemForm
              taxRates={taxRates}
              catalogRef={catalogRef}
              row={editing.kind === "edit" ? editing.row : null}
              groups={groups}
              onSaved={async () => {
                setEditing(null);
                await onChanged();
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {items.length === 0 && !editing && (
        <p className="rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 text-center text-sm text-ink-400">{t("menuEditor.none")}</p>
      )}

      <motion.div variants={staggerContainer} initial="hidden" animate="visible">
        {[...grouped.entries()].map(([category, rows]) => (
          <motion.div variants={fadeSlideUp} key={category} className="mb-4">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">{category}</p>
            <div className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900">
              {rows.map((row) => (
                <div key={bytesToHex(row.hash)} className="flex items-center gap-3 p-4">
                  {row.item.photo_data_uri && <img src={row.item.photo_data_uri} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{row.item.name}</p>
                    {row.item.description && <p className="truncate text-xs text-ink-400">{row.item.description}</p>}
                    {row.item.modifier_groups.length > 0 && (
                      <p className="truncate text-xs text-ink-400">
                        Choices: {row.item.modifier_groups.map((ref) => groups.find((g) => bytesToHex(g.hash) === bytesToHex(ref))?.group.name ?? "…").join(", ")}
                      </p>
                    )}
                    <StatNumber className="text-sm">{formatCents(row.item.price_cents)}</StatNumber>
                  </div>
                  <motion.button
                    whileTap={{ scale: 0.95 }}
                    onClick={() => toggleAvailable(row)}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${row.item.available ? "bg-presence-500/15 text-presence-600" : "bg-ink-100 text-ink-400"}`}
                  >
                    {row.item.available ? t("menuEditor.available") : t("item.soldOut")}
                  </motion.button>
                  <button onClick={() => setEditing({ kind: "edit", row })} className="text-ink-400 hover:text-relay-600" aria-label={t("choicesEditor.edit", { name: row.item.name })}>
                    <Pencil size={14} />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        ))}
      </motion.div>
    </>
  );
}

/// Add (`row` null) or edit an item. The draft is seeded once, on mount.
function ItemForm({ catalogRef, row, groups, taxRates, onSaved }: { catalogRef: Uint8Array; row: ItemRow | null; groups: GroupRow[]; taxRates: TaxRate[]; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState(() => ({
    name: row?.item.name ?? "",
    price: row ? fromMinorUnits(row.item.price_cents) : 0,
    description: row?.item.description ?? "",
    photo_data_uri: row?.item.photo_data_uri ?? "",
    category: row?.item.category ?? "",
    dietary_tags: (row?.item.dietary_tags ?? []).join(", "),
    /// The item's choice groups, by hex, in the order customers see them.
    groups: (row?.item.modifier_groups ?? []).map(bytesToHex),
    tax_category: row?.item.tax_category ?? "",
    age_restricted: row?.item.age_restricted ?? false,
  }));
  const minAge = useTerms().restricted_min_age;
  const t = useT();
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const fields = {
        name: form.name.trim(),
        price_cents: toMinorUnits(form.price),
        description: form.description,
        photo_data_uri: form.photo_data_uri,
        category: form.category,
        dietary_tags: form.dietary_tags.split(",").map((t) => t.trim()).filter(Boolean),
        modifier_groups: form.groups.map(hexToBytes),
        tax_category: form.tax_category,
        age_restricted: form.age_restricted,
      };
      if (row) await updateMenuItem(row.hash, { ...row.item, ...fields });
      else await addMenuItem({ catalog_ref: catalogRef, available: true, ...fields });
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-4 flex flex-col gap-2 p-4">
      <div className="flex gap-3">
        <PhotoInput value={form.photo_data_uri} onChange={(v) => set({ photo_data_uri: v })} shape="circle" className="shrink-0" />
        <div className="flex flex-1 flex-col gap-2">
          <Input maxLength={MAX_NAME_CHARS} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={t("menuEditor.name")} />
          <Input type="number" min={0} step={0.5} value={form.price} onChange={(e) => set({ price: Number(e.target.value) })} placeholder="0.00" prefix={currencySymbol()} />
        </div>
      </div>
      <Textarea maxLength={MAX_DESCRIPTION_CHARS} value={form.description} onChange={(e) => set({ description: e.target.value })} rows={2} placeholder={t("storeSettings.description")} />
      <Input maxLength={MAX_LABEL_CHARS} value={form.category} onChange={(e) => set({ category: e.target.value })} placeholder={t("menuEditor.category")} />
      <Input value={form.dietary_tags} onChange={(e) => set({ dietary_tags: e.target.value })} placeholder={t("menuEditor.tags")} />
      {taxRates.length > 1 && (
        <Field label={t("cart.tax")}>
          <Select value={form.tax_category} onChange={(e) => set({ tax_category: e.target.value })}>
            {taxRates.map((rate, i) => (
              <option key={rate.category} value={i === 0 ? "" : rate.category}>
                {rate.category} · {percentLabel(rate.basis_points)}
                {i === 0 ? ` ${t("menuEditor.default")}` : ""}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {/* Only on a network that sells age-restricted items -- and an item
          already marked can be unmarked anywhere. */}
      {(minAge || form.age_restricted) && (
        <label className="flex items-center gap-2 text-sm text-ink-600 dark:text-ink-300">
          <Checkbox checked={form.age_restricted} onChange={(e) => set({ age_restricted: e.target.checked })} />
          {t("menuEditor.ageRestricted", { age: minAge ?? 18 })}
        </label>
      )}
      {groups.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold text-ink-500">{t("menuEditor.choices")}</p>
          <div className="flex flex-wrap gap-1.5">
            {groups.map((g) => {
              const hex = bytesToHex(g.hash);
              const position = form.groups.indexOf(hex);
              const full = position < 0 && form.groups.length >= MAX_ITEM_GROUPS;
              return (
                <button
                  key={hex}
                  type="button"
                  disabled={full}
                  onClick={() => set({ groups: position < 0 ? [...form.groups, hex] : form.groups.filter((h) => h !== hex) })}
                  className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold transition disabled:opacity-40 ${position >= 0 ? "bg-relay-500 text-white" : "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300"}`}
                >
                  {position >= 0 ? <span className="tabular-nums">{position + 1}.</span> : <Check size={12} className="opacity-0" />}
                  {g.group.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <Button loading={saving} disabled={!form.name.trim()} onClick={save} className="py-2 text-xs">
        {row ? t("menuEditor.save") : t("menuEditor.addToMenu")}
      </Button>
    </Card>
  );
}
