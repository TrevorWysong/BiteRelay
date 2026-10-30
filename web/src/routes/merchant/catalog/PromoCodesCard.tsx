import { useState } from "react";
import { Gift, ListChecks, Plus, Sparkles, Tag } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { createPromoCode, listPromoCodesForCatalog, setPromoCodeActive } from "../../../holochain/zomes/catalog";
import { bytesToHex, decodeEntry } from "../../../holochain/decode";
import { useResource } from "../../../lib/hooks/useResource";
import { describeRequirement, describeReward } from "../../../lib/menu/promotions";
import { itemNamesByHex, type ItemRow } from "../../../lib/menu/menu";
import { Button, Card, Checkbox, Input, Select } from "../../../components/ui";
import { buildRequirement, buildReward, EMPTY_PROMO_FORM, type PromoForm, type RequirementKind, type RewardKind } from "./promoForm";
import type { PromoCode, Timestamp } from "../../../holochain/types";
import { MAX_PROMO_CODE_CHARS } from "../../../holochain/types";
import { currencySymbol } from "../../../lib/ui/format";
import { useT } from "../../../i18n";

interface PromoRow {
  /// The code's identity (its original action) -- what orders reference.
  hash: Uint8Array;
  hex: string;
  promo: PromoCode;
}

interface PromoList {
  rows: PromoRow[];
  nextBefore: Timestamp | null;
}

async function fetchPromoPage(catalogRef: Uint8Array, before: Timestamp | null): Promise<PromoList> {
  const page = await listPromoCodesForCatalog(catalogRef, before);
  return {
    rows: page.promo_codes.map((v) => ({ hash: v.original_action, hex: bytesToHex(v.original_action), promo: decodeEntry<PromoCode>(v.record) })),
    nextBefore: page.next_before,
  };
}

/// Every promo code the store has created, newest first, a page at a time
/// -- plus the form for a new one.
export function PromoCodesCard({ storeHex, catalogRef, items }: { storeHex: string; catalogRef: Uint8Array; items: ItemRow[] }) {
  const t = useT();
  const [showForm, setShowForm] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const { data, reload, mutate } = useResource(`store-promos:${storeHex}`, () => fetchPromoPage(catalogRef, null));
  const names = itemNamesByHex(items);
  const itemName = (hex: string) => names[hex];

  async function toggle(row: PromoRow) {
    setToggling(row.hex);
    try {
      await setPromoCodeActive(row.hash, !row.promo.active);
      // Update in place: reloading would collapse any "load more" pages.
      mutate((prev) => ({ nextBefore: prev?.nextBefore ?? null, rows: (prev?.rows ?? []).map((r) => (r.hex === row.hex ? { ...r, promo: { ...r.promo, active: !r.promo.active } } : r)) }));
    } finally {
      setToggling(null);
    }
  }

  async function loadMore() {
    if (!data?.nextBefore) return;
    setLoadingMore(true);
    try {
      const next = await fetchPromoPage(catalogRef, data.nextBefore);
      mutate((prev) => {
        const seen = new Set((prev?.rows ?? []).map((r) => r.hex));
        return { rows: [...(prev?.rows ?? []), ...next.rows.filter((r) => !seen.has(r.hex))], nextBefore: next.nextBefore };
      });
    } finally {
      setLoadingMore(false);
    }
  }

  const rows = data?.rows ?? [];
  return (
    <Card className="mb-4 p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
          <Tag size={13} /> {t("promoEditor.title")}
        </p>
        <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => setShowForm((v) => !v)}>
          <Plus size={14} /> {showForm ? t("common.cancel") : t("promoEditor.new")}
        </Button>
      </div>
      <AnimatePresence initial={false}>
        {showForm && (
          <NewPromoForm
            catalogRef={catalogRef}
            items={items}
            itemName={itemName}
            onCreated={async () => {
              setShowForm(false);
              await reload();
            }}
          />
        )}
      </AnimatePresence>
      {data && rows.length === 0 && !showForm ? (
        <p className="text-sm text-ink-400">{t("promoEditor.none")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.hex} className="flex items-center justify-between rounded-lg bg-ink-50 dark:bg-ink-800/60 px-3 py-2">
              <div>
                <p className="font-mono text-sm font-semibold text-ink-900 dark:text-ink-50">
                  {row.promo.code}
                  {row.promo.auto_apply && <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-presence-600">{t("promoEditor.auto")}</span>}
                </p>
                <p className="text-xs text-ink-400">
                  {describeRequirement(row.promo.requirement, itemName)} · {describeReward(row.promo.reward, itemName)}
                </p>
              </div>
              <Button variant={row.promo.active ? "secondary" : "ghost"} className="px-3 py-1.5 text-xs" loading={toggling === row.hex} onClick={() => toggle(row)}>
                {row.promo.active ? t("orders.active") : t("promoEditor.inactive")}
              </Button>
            </div>
          ))}
          {data?.nextBefore && (
            <Button variant="ghost" loading={loadingMore} onClick={loadMore} className="w-full py-2 text-xs">
              {t("promoEditor.older")}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/// Owns its own draft, so closing it (or creating a code) throws the draft
/// away by unmounting -- nothing to reset by hand.
function NewPromoForm({ catalogRef, items, itemName, onCreated }: { catalogRef: Uint8Array; items: ItemRow[]; itemName: (hex: string) => string | undefined; onCreated: () => Promise<void> }) {
  const t = useT();
  const [form, setForm] = useState<PromoForm>(EMPTY_PROMO_FORM);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<PromoForm>) => setForm((f) => ({ ...f, ...patch }));
  const requirement = buildRequirement(form);
  const reward = buildReward(form);
  const ready = !!form.code.trim() && !!requirement && !!reward;

  async function save() {
    if (!ready) return;
    setSaving(true);
    try {
      await createPromoCode({ catalog_ref: catalogRef, code: form.code.trim().toUpperCase(), requirement: requirement!, reward: reward!, auto_apply: form.autoApply });
      await onCreated();
    } finally {
      setSaving(false);
    }
  }

  const itemSelect = (value: string, onChange: (hex: string) => void) => (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="flex-1">
      <option value="">{t("promoEditor.selectItem")}</option>
      {items.map((row) => (
        <option key={bytesToHex(row.hash)} value={bytesToHex(row.hash)}>
          {row.item.name}
        </option>
      ))}
    </Select>
  );
  const percentReward = form.rewardKind !== "flatOffSubtotal";
  const itemReward = form.rewardKind === "freeItem" || form.rewardKind === "percentOffItem";

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="mb-3 flex flex-col gap-3 rounded-2xl border border-ink-200/70 dark:border-ink-700/70 bg-white dark:bg-ink-900/40 p-4 shadow-sm"
    >
      <Input maxLength={MAX_PROMO_CODE_CHARS} value={form.code} onChange={(e) => set({ code: e.target.value })} placeholder={t("promoEditor.codePlaceholder")} className="font-mono uppercase tracking-wide" />

      <div className="rounded-xl bg-ink-50 dark:bg-ink-800/50 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-400">
          <ListChecks size={13} className="text-handshake-500" /> {t("promoEditor.requirement")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={form.requirementKind} onChange={(e) => set({ requirementKind: e.target.value as RequirementKind })} className="flex-1 min-w-[11rem]">
            <option value="none">{t("promoEditor.req.none")}</option>
            <option value="minSpend">{t("promoEditor.req.spend")}</option>
            <option value="minItemQty">{t("promoEditor.req.quantity")}</option>
            <option value="loyalty">{t("promoEditor.req.loyalty")}</option>
          </Select>
          {form.requirementKind === "minSpend" && (
            <Input type="number" min={0.01} step={0.5} value={form.requirementAmount} onChange={(e) => set({ requirementAmount: Number(e.target.value) })} prefix={currencySymbol()} className="w-24" />
          )}
          {form.requirementKind === "loyalty" && (
            <Input type="number" min={1} step={1} value={form.requirementAmount} onChange={(e) => set({ requirementAmount: Number(e.target.value) })} placeholder={t("promoEditor.priorOrders")} className="w-28" />
          )}
        </div>
        {form.requirementKind === "loyalty" && (
          <label className="mt-2.5 flex items-center gap-2 text-xs text-ink-400">
            <Checkbox checked={form.autoApply} onChange={(e) => set({ autoApply: e.target.checked })} />
            {t("promoEditor.autoApply")}
          </label>
        )}
        {form.requirementKind === "minItemQty" && (
          <div className="mt-2.5 flex items-center gap-2">
            {itemSelect(form.requirementItemHex, (hex) => set({ requirementItemHex: hex }))}
            <Input type="number" min={1} step={1} value={form.requirementAmount} onChange={(e) => set({ requirementAmount: Number(e.target.value) })} placeholder={t("promoEditor.qty")} className="w-20" />
          </div>
        )}
      </div>

      <div className="rounded-xl bg-ink-50 dark:bg-ink-800/50 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-400">
          <Gift size={13} className="text-handshake-500" /> {t("promoEditor.reward")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={form.rewardKind} onChange={(e) => set({ rewardKind: e.target.value as RewardKind })} className="flex-1 min-w-[11rem]">
            <option value="percentOffSubtotal">{t("promoEditor.rew.percentOrder")}</option>
            <option value="flatOffSubtotal">{t("promoEditor.rew.flatOrder", { currency: currencySymbol() })}</option>
            <option value="freeItem">{t("promoEditor.rew.free")}</option>
            <option value="percentOffItem">{t("promoEditor.rew.percentItem")}</option>
          </Select>
          {form.rewardKind !== "freeItem" && (
            <Input
              type="number"
              min={percentReward ? 1 : 0.01}
              max={percentReward ? 100 : undefined}
              step={percentReward ? 1 : 0.5}
              value={form.rewardAmount}
              onChange={(e) => set({ rewardAmount: Number(e.target.value) })}
              prefix={percentReward ? undefined : currencySymbol()}
              suffix={percentReward ? "%" : undefined}
              className="w-24"
            />
          )}
        </div>
        {itemReward && (
          <div className="mt-2.5 flex items-center gap-2">
            {itemSelect(form.rewardItemHex, (hex) => set({ rewardItemHex: hex }))}
            <Input type="number" min={1} step={1} value={form.rewardQuantity} onChange={(e) => set({ rewardQuantity: Number(e.target.value) })} placeholder={t("promoEditor.qty")} className="w-20" />
          </div>
        )}
      </div>

      {requirement && reward && (
        <div className="flex items-start gap-2 rounded-xl bg-handshake-50 dark:bg-handshake-900/20 px-3 py-2.5 text-xs text-handshake-700 dark:text-handshake-300">
          <Sparkles size={14} className="mt-0.5 shrink-0" />
          <span>
            {describeRequirement(requirement, itemName)} · {describeReward(reward, itemName)}
          </span>
        </div>
      )}

      <Button loading={saving} disabled={!ready} onClick={save} className="py-2.5 text-xs">
        {t("promoEditor.create")}
      </Button>
    </motion.div>
  );
}
