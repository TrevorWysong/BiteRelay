import { useState } from "react";
import { PackageOpen } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { confirmClaim, createGoodieBag, listGoodieBagsForCatalog, listPendingClaimsForMerchant } from "../../../holochain/zomes/catalog";
import { actionHash, bytesToHex, decodeEntry } from "../../../holochain/decode";
import { useResource } from "../../../lib/useResource";
import { formatCents, toMinorUnits, currencySymbol } from "../../../lib/format";
import { fadeSlideUp, staggerContainer } from "../../../lib/motion";
import { Button, Card, Checkbox, Field, Input, StatNumber, Textarea } from "../../../components/ui";
import { PhotoInput } from "../../../components/PhotoInput";
import type { BagClaim, GoodieBag } from "../../../holochain/types";
import { POLL } from "../../../lib/poll";
import { useTerms } from "../../../store/network";
import { MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS } from "../../../holochain/types";

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
  const [showForm, setShowForm] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
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
        <p className="text-xs font-bold uppercase tracking-wide text-ink-400">Goodie bags</p>
        <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => setShowForm((v) => !v)}>
          <PackageOpen size={14} /> {showForm ? "Cancel" : "Add a bag"}
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
        <p className="mb-4 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 text-center text-sm text-ink-400">No goodie bags listed right now.</p>
      ) : (
        <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="mb-4 flex flex-col divide-y divide-ink-100 dark:divide-ink-800 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900">
          {bags.map(({ hex, bag }) => (
            <motion.div key={hex} variants={fadeSlideUp} className="flex items-center gap-3 p-4">
              {bag.photo_data_uri && <img src={bag.photo_data_uri} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{bag.title}</p>
                <p className="text-xs text-ink-400">
                  {new Date(bag.pickup_window_start / 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} –{" "}
                  {new Date(bag.pickup_window_end / 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {bag.quantity_total} available
                </p>
                <div className="flex items-center gap-2">
                  <StatNumber className="text-sm">{formatCents(bag.price_cents)}</StatNumber>
                  <span className="text-xs text-ink-400 line-through">{formatCents(bag.original_value_cents)}</span>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      )}

      {claims.length > 0 && (
        <motion.div variants={fadeSlideUp} className="mb-6">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">Pending bag claims</p>
          <div className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900">
            {claims.map(({ hash, hex, claim }) => (
              <div key={hex} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{bagTitle.get(bytesToHex(claim.bag_ref)) ?? "Goodie bag"}</p>
                  <p className="text-xs text-ink-400">{claim.fulfillment === "Pickup" ? "Will pick up" : "Wants delivery"}</p>
                </div>
                <Button loading={confirming === hex} className="px-3 py-1.5 text-xs" onClick={() => confirm(hash, hex)}>
                  Confirm
                </Button>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </>
  );
}

function toLocalInput(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/// Seeded once on mount with a window starting in an hour and lasting two.
function NewBagForm({ catalogRef, onCreated }: { catalogRef: Uint8Array; onCreated: () => Promise<void> }) {
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
      ? "Give the bag a name."
      : form.price <= 0 || form.price > form.originalValue
        ? "The price must be more than nothing, and no more than the bag's value."
        : !form.supports_pickup && !form.supports_delivery
          ? "Offer it for pickup, delivery, or both."
          : !(endMs > startMs)
            ? "The pickup window must end after it starts."
            : endMs - openedAt > maxDays * DAY_MS
              ? `The pickup window must end within ${maxDays} days.`
              : !(form.holdMinutes >= 1 && form.holdMinutes * 60_000 <= maxDays * DAY_MS)
                ? "Hold a claim for at least a minute."
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
          <Field label="Bag name">
            <Input maxLength={MAX_NAME_CHARS} value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="End-of-day goodie bag" />
          </Field>
          <div className="flex gap-2">
            <Field label="Value">
              <Input type="number" min={0} step={0.5} value={form.originalValue} onChange={(e) => set({ originalValue: Number(e.target.value) })} prefix={currencySymbol()} />
            </Field>
            <Field label="Price">
              <Input type="number" min={0} step={0.5} value={form.price} onChange={(e) => set({ price: Number(e.target.value) })} prefix={currencySymbol()} />
            </Field>
          </div>
        </div>
      </div>
      <Field label="Description">
        <Textarea maxLength={MAX_DESCRIPTION_CHARS} value={form.description} onChange={(e) => set({ description: e.target.value })} rows={2} placeholder="What's usually in it? (optional -- contents vary by day)" />
      </Field>
      <div className="flex gap-2">
        <Field label="Quantity available">
          <Input type="number" min={1} step={1} value={form.quantity_total} onChange={(e) => set({ quantity_total: Number(e.target.value) })} />
        </Field>
        <Field label="Hold a claim for (min)">
          <Input type="number" min={1} step={1} value={form.holdMinutes} onChange={(e) => set({ holdMinutes: Math.round(Number(e.target.value)) })} />
        </Field>
      </div>
      <p className="text-[11px] text-ink-400">A bag you confirm is held for its customer this long. If they haven't ordered it by then, it goes back on sale.</p>
      <div className="flex gap-2">
        <Field label="Pickup window starts">
          <Input type="datetime-local" value={form.start} onChange={(e) => set({ start: e.target.value })} />
        </Field>
        <Field label="Pickup window ends">
          <Input type="datetime-local" value={form.end} onChange={(e) => set({ end: e.target.value })} />
        </Field>
      </div>
      <p className="text-[11px] text-ink-400">Only the name, description and photo can be changed after listing.</p>
      <div className="flex gap-4 pt-1">
        <label className="flex items-center gap-2 text-xs text-ink-500">
          <Checkbox checked={form.supports_pickup} onChange={(e) => set({ supports_pickup: e.target.checked })} />
          Offer for pickup
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-500">
          <Checkbox checked={form.supports_delivery} onChange={(e) => set({ supports_delivery: e.target.checked })} />
          Offer for delivery
        </label>
      </div>
      {problem && form.title.trim() && <p className="text-xs text-amber-600">{problem}</p>}
      <Button loading={saving} disabled={!!problem} onClick={save} className="py-2.5 text-xs">
        List goodie bag
      </Button>
    </Card>
  );
}
