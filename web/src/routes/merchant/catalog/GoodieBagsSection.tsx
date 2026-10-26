import { useState } from "react";
import { PackageOpen, Pencil } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { confirmClaim, createGoodieBag, listGoodieBagsForCatalog, listPendingClaimsForMerchant, updateGoodieBag } from "../../../holochain/zomes/catalog";
import { actionHash, bytesToHex, decodeEntry, hexToBytes } from "../../../holochain/decode";
import { useResource } from "../../../lib/useResource";
import { describeError } from "../../../lib/errors";
import { formatCents, formatClockTime, toMinorUnits, currencySymbol } from "../../../lib/format";
import { fadeSlideUp, staggerContainer } from "../../../lib/motion";
import { Button, Card, Checkbox, Field, Input, StatNumber, Textarea } from "../../../components/ui";
import { PhotoInput } from "../../../components/PhotoInput";
import type { BagClaim, GoodieBag } from "../../../holochain/types";
import { POLL } from "../../../lib/poll";
import { useTerms } from "../../../store/network";
import { MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS } from "../../../holochain/types";
import { appLocale, useT } from "../../../i18n";

const DAY_MS = 24 * 60 * 60 * 1000;

interface BagsData {
  bags: { hex: string; bag: GoodieBag }[];
  claims: { hash: Uint8Array; hex: string; claim: BagClaim }[];
}

async function fetchBags(catalogRef: Uint8Array): Promise<BagsData> {
  const [bagViews, claimRecords] = await Promise.all([listGoodieBagsForCatalog(catalogRef), listPendingClaimsForMerchant(catalogRef)]);
  return {
    bags: bagViews.map((v) => ({ hex: bytesToHex(v.original_action), bag: decodeEntry<GoodieBag>(v.record) })),
    claims: claimRecords.map((r) => ({ hash: actionHash(r), hex: bytesToHex(actionHash(r)), claim: decodeEntry<BagClaim>(r) })),
  };
}

/// The store's live goodie bags, a form to list a new one, and the claims
/// waiting on the merchant -- polled, since claims arrive from customers.
export function GoodieBagsSection({ storeHex, catalogRef }: { storeHex: string; catalogRef: Uint8Array }) {
  const t = useT();
  const [showForm, setShowForm] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const { data, reload } = useResource(`store-bags:${storeHex}`, () => fetchBags(catalogRef), { pollMs: POLL.signalled, refreshOn: () => true });
  const bags = data?.bags ?? [];
  const claims = data?.claims ?? [];
  const bagTitle = new Map(bags.map((b) => [b.hex, b.bag.title]));

  async function confirm(hash: Uint8Array, hex: string) {
    setConfirming(hex);
    try {
      await confirmClaim(hash);
      await reload();
    } finally {
      setConfirming(null);
    }
  }

  return (
    <>
      <motion.div variants={fadeSlideUp} className="mb-3 flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-400">{t("bags.title")}</p>
        <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => setShowForm((v) => !v)}>
          <PackageOpen size={14} /> {showForm ? t("common.cancel") : t("bags.add")}
        </Button>
      </motion.div>

      <AnimatePresence initial={false}>
        {showForm && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <NewBagForm
              catalogRef={catalogRef}
              onCreated={async () => {
                setShowForm(false);
                await reload();
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {data && bags.length === 0 && !showForm ? (
        <p className="mb-4 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 text-center text-sm text-ink-400">{t("bags.none")}</p>
      ) : (
        <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="mb-4 flex flex-col divide-y divide-ink-100 dark:divide-ink-800 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900">
          {bags.map(({ hex, bag }) =>
            editing === hex ? (
              <EditBagForm
                key={hex}
                original={hexToBytes(hex)}
                bag={bag}
                onDone={async (saved) => {
                  setEditing(null);
                  if (saved) await reload();
                }}
              />
            ) : (
            <motion.div key={hex} variants={fadeSlideUp} className="flex items-center gap-3 p-4">
              {bag.photo_data_uri && <img src={bag.photo_data_uri} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{bag.title}</p>
                <p className="text-xs text-ink-400">
                  {new Date(bag.pickup_window_start / 1000).toLocaleString(appLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} –{" "}
                  {formatClockTime(bag.pickup_window_end)} · {t("bags.available", { count: bag.quantity_total })}
                </p>
                <div className="flex items-center gap-2">
                  <StatNumber className="text-sm">{formatCents(bag.price_cents)}</StatNumber>
                  <span className="text-xs text-ink-400 line-through">{formatCents(bag.original_value_cents)}</span>
                </div>
              </div>
              <Button variant="ghost" className="px-2 py-1.5 text-xs" aria-label={t("common.edit")} onClick={() => setEditing(hex)}>
                <Pencil size={14} />
              </Button>
            </motion.div>
            ),
          )}
        </motion.div>
      )}

      {claims.length > 0 && (
        <motion.div variants={fadeSlideUp} className="mb-6">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">{t("bags.pending")}</p>
          <div className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900">
            {claims.map(({ hash, hex, claim }) => (
              <div key={hex} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{bagTitle.get(bytesToHex(claim.bag_ref)) ?? t("orders.goodieBag")}</p>
                  <p className="text-xs text-ink-400">{claim.fulfillment === "Pickup" ? t("bags.willPickUp") : t("bags.wantsDelivery")}</p>
                </div>
                <Button loading={confirming === hex} className="px-3 py-1.5 text-xs" onClick={() => confirm(hash, hex)}>
                  {t("bags.confirm")}
                </Button>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </>
  );
}

/// A listed bag's words and photo, edited in place -- all of it a bag may
/// change once listed; its price, quantity and window stay as customers
/// first saw them.
function EditBagForm({ original, bag, onDone }: { original: Uint8Array; bag: GoodieBag; onDone: (saved: boolean) => Promise<void> }) {
  const t = useT();
  const [form, setForm] = useState({ title: bag.title, description: bag.description, photo_data_uri: bag.photo_data_uri });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateGoodieBag(original, { ...bag, title: form.title.trim(), description: form.description, photo_data_uri: form.photo_data_uri });
      await onDone(true);
    } catch (err) {
      setError(describeError(err));
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex gap-3">
        <PhotoInput value={form.photo_data_uri} onChange={(v) => setForm((f) => ({ ...f, photo_data_uri: v }))} shape="circle" className="shrink-0" />
        <Field label={t("bags.name")} className="flex-1">
          <Input maxLength={MAX_NAME_CHARS} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        </Field>
      </div>
      <Field label={t("storeSettings.description")}>
        <Textarea maxLength={MAX_DESCRIPTION_CHARS} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
      </Field>
      <p className="text-[11px] text-ink-400">{t("bags.fixed")}</p>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <Button variant="ghost" className="flex-1 py-2 text-xs" disabled={saving} onClick={() => onDone(false)}>
          {t("common.cancel")}
        </Button>
        <Button className="flex-1 py-2 text-xs" loading={saving} disabled={!form.title.trim()} onClick={save}>
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

function toLocalInput(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/// Seeded once on mount with a window starting in an hour and lasting two.
function NewBagForm({ catalogRef, onCreated }: { catalogRef: Uint8Array; onCreated: () => Promise<void> }) {
  const t = useT();
  // The longest a bag may stay listed -- validation refuses longer -- and
  // how long a confirmed claim is held, unless the store says otherwise.
  const { goodie_bag_max_days: maxDays, default_bag_hold_minutes: defaultHold } = useTerms();
  const [form, setForm] = useState(() => {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    return {
      title: "",
      description: "",
      photo_data_uri: "",
      originalValue: 15,
      price: 5,
      quantity_total: 3,
      start: toLocalInput(start),
      end: toLocalInput(new Date(start.getTime() + 2 * 60 * 60 * 1000)),
      supports_pickup: true,
      supports_delivery: false,
      holdMinutes: defaultHold,
    };
  });
  const [saving, setSaving] = useState(false);
  // When the form opened -- close enough to "when it's listed" for the
  // 7-day check, and read once rather than on every render.
  const [openedAt] = useState(() => Date.now());
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const startMs = new Date(form.start).getTime();
  const endMs = new Date(form.end).getTime();
  // The same rules validation enforces, surfaced before the round trip.
  const problem =
    !form.title.trim()
      ? t("bags.problem.name")
      : form.price <= 0 || form.price > form.originalValue
        ? t("bags.problem.price")
        : !form.supports_pickup && !form.supports_delivery
          ? t("bags.problem.fulfillment")
          : !(endMs > startMs)
            ? t("bags.problem.window")
            : endMs - openedAt > maxDays * DAY_MS
              ? t("bags.problem.tooLong", { count: maxDays })
              : !(form.holdMinutes >= 1 && form.holdMinutes * 60_000 <= maxDays * DAY_MS)
                ? t("bags.problem.hold")
                : null;

  async function save() {
    if (problem) return;
    setSaving(true);
    try {
      await createGoodieBag({
        catalog_ref: catalogRef,
        title: form.title.trim(),
        description: form.description,
        photo_data_uri: form.photo_data_uri,
        original_value_cents: toMinorUnits(form.originalValue),
        price_cents: toMinorUnits(form.price),
        quantity_total: form.quantity_total,
        pickup_window_start: startMs * 1000,
        pickup_window_end: endMs * 1000,
        supports_pickup: form.supports_pickup,
        supports_delivery: form.supports_delivery,
        hold_minutes: form.holdMinutes,
      });
      await onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-4 flex flex-col gap-2 p-4">
      <div className="flex gap-3">
        <PhotoInput value={form.photo_data_uri} onChange={(v) => set({ photo_data_uri: v })} shape="circle" className="shrink-0" />
        <div className="flex flex-1 flex-col gap-2">
          <Field label={t("bags.name")}>
            <Input maxLength={MAX_NAME_CHARS} value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder={t("bags.namePlaceholder")} />
          </Field>
          <div className="flex gap-2">
            <Field label={t("bags.value")}>
              <Input type="number" min={0} step={0.5} value={form.originalValue} onChange={(e) => set({ originalValue: Number(e.target.value) })} prefix={currencySymbol()} />
            </Field>
            <Field label={t("bags.price")}>
              <Input type="number" min={0} step={0.5} value={form.price} onChange={(e) => set({ price: Number(e.target.value) })} prefix={currencySymbol()} />
            </Field>
          </div>
        </div>
      </div>
      <Field label={t("storeSettings.description")}>
        <Textarea maxLength={MAX_DESCRIPTION_CHARS} value={form.description} onChange={(e) => set({ description: e.target.value })} rows={2} placeholder={t("bags.descriptionPlaceholder")} />
      </Field>
      <div className="flex gap-2">
        <Field label={t("bags.quantity")}>
          <Input type="number" min={1} step={1} value={form.quantity_total} onChange={(e) => set({ quantity_total: Number(e.target.value) })} />
        </Field>
        <Field label={t("bags.hold")}>
          <Input type="number" min={1} step={1} value={form.holdMinutes} onChange={(e) => set({ holdMinutes: Math.round(Number(e.target.value)) })} />
        </Field>
      </div>
      <p className="text-[11px] text-ink-400">{t("bags.holdDetail")}</p>
      <div className="flex gap-2">
        <Field label={t("bags.windowStart")}>
          <Input type="datetime-local" value={form.start} onChange={(e) => set({ start: e.target.value })} />
        </Field>
        <Field label={t("bags.windowEnd")}>
          <Input type="datetime-local" value={form.end} onChange={(e) => set({ end: e.target.value })} />
        </Field>
      </div>
      <p className="text-[11px] text-ink-400">{t("bags.fixed")}</p>
      <div className="flex gap-4 pt-1">
        <label className="flex items-center gap-2 text-xs text-ink-500">
          <Checkbox checked={form.supports_pickup} onChange={(e) => set({ supports_pickup: e.target.checked })} />
          {t("bags.offerPickup")}
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-500">
          <Checkbox checked={form.supports_delivery} onChange={(e) => set({ supports_delivery: e.target.checked })} />
          {t("bags.offerDelivery")}
        </label>
      </div>
      {problem && form.title.trim() && <p className="text-xs text-amber-600">{problem}</p>}
      <Button loading={saving} disabled={!!problem} onClick={save} className="py-2.5 text-xs">
        {t("bags.list")}
      </Button>
    </Card>
  );
}
