import { useState } from "react";
import { Pencil } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { closeListing, detailsOf, isStoreListed, reopenListing, setAutoAcceptOrders, setBusy, setDeliverySubsidyPercent, setLeaveAtDoorLimit, setMinimumOrder, updateCatalogDetails, setStoreWait } from "../../../holochain/zomes/catalog";
import { formatCatalogAddress, formatCents, toMinorUnits, fromMinorUnits, currencySymbol } from "../../../lib/format";
import { useResource } from "../../../lib/useResource";
import { describeError } from "../../../lib/errors";
import { bytesToHex } from "../../../holochain/decode";
import { Button, Card, Field, Input, Switch, Textarea } from "../../../components/ui";
import { PhotoInput } from "../../../components/PhotoInput";
import { SplitAddressFields } from "../../../components/SplitAddressFields";
import type { MerchantCatalog } from "../../../holochain/types";
import { MAX_DESCRIPTION_CHARS, MAX_LABEL_CHARS, MAX_PHONE_CHARS } from "../../../holochain/types";
import { useTerms } from "../../../store/network";

/// The storefront's details: a read-only summary, or the editor.
export function StoreDetailsCard({ catalog, catalogRef, startEditing, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; startEditing: boolean; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState(startEditing);
  return (
    <Card className="my-4 p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-400">Storefront details</p>
        <button onClick={() => setEditing((v) => !v)} className="text-ink-400 hover:text-relay-600" aria-label="Edit storefront details">
          <Pencil size={14} />
        </button>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {editing ? (
          <motion.div key="edit" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <DetailsEditor
              catalog={catalog}
              onSave={async (draft) => {
                await updateCatalogDetails(catalogRef, { ...detailsOf(catalog), ...draft });
                await onSaved();
                setEditing(false);
              }}
            />
          </motion.div>
        ) : (
          <motion.div key="view" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm text-ink-600 dark:text-ink-300">
            <p>{catalog.description || "No description yet."}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-400">
              {catalog.cuisine_type && <span>{catalog.cuisine_type}</span>}
              {formatCatalogAddress(catalog) && <span>{formatCatalogAddress(catalog)}</span>}
              {catalog.phone && <span>{catalog.phone}</span>}
              <span>Delivers within {catalog.max_delivery_radius_km}km</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

type DetailsDraft = ReturnType<typeof detailsDraftFrom>;

function detailsDraftFrom(catalog: MerchantCatalog) {
  return {
    description: catalog.description,
    cuisine_type: catalog.cuisine_type,
    banner_data_uri: catalog.banner_data_uri,
    phone: catalog.phone,
    address_street: catalog.address_street,
    address_city: catalog.address_city,
    address_state: catalog.address_state,
    address_zip: catalog.address_zip,
    max_delivery_radius_km: catalog.max_delivery_radius_km,
  };
}

/// Owns its draft, seeded from the saved details when the editor mounts --
/// so a background refresh can never overwrite an edit in progress.
function DetailsEditor({ catalog, onSave }: { catalog: MerchantCatalog; onSave: (draft: DetailsDraft) => Promise<void> }) {
  const [draft, setDraft] = useState(() => detailsDraftFrom(catalog));
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<DetailsDraft>) => setDraft((d) => ({ ...d, ...patch }));

  async function save() {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <PhotoInput value={draft.banner_data_uri} onChange={(v) => set({ banner_data_uri: v })} shape="banner" />
      <Field label="Description">
        <Textarea maxLength={MAX_DESCRIPTION_CHARS} value={draft.description} onChange={(e) => set({ description: e.target.value })} rows={2} placeholder="Describe your restaurant" />
      </Field>
      <Field label="Cuisine">
        <Input maxLength={MAX_LABEL_CHARS} value={draft.cuisine_type} onChange={(e) => set({ cuisine_type: e.target.value })} placeholder="Cuban, Italian, …" />
      </Field>
      {/* The pickup point itself can't move after publishing (see
          update_catalog_details), so only the address text is editable. */}
      <SplitAddressFields
        point={catalog.location}
        onPointChange={() => {}}
        pointIsEditable={false}
        address={{ street: draft.address_street, city: draft.address_city, state: draft.address_state, zip: draft.address_zip }}
        onAddressChange={(a) => set({ address_street: a.street, address_city: a.city, address_state: a.state, address_zip: a.zip })}
      />
      <Field label="Phone">
        <Input maxLength={MAX_PHONE_CHARS} value={draft.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="(555) 555-0100" />
      </Field>
      <Field label="Delivery radius (km)">
        <Input type="number" min={0} step="any" value={draft.max_delivery_radius_km} onChange={(e) => set({ max_delivery_radius_km: Number(e.target.value) })} placeholder="8" />
      </Field>
      <Button loading={saving} onClick={save} className="py-2 text-xs">
        Save
      </Button>
    </div>
  );
}

/// The store's share of each delivery fee.
export function DeliverySubsidyCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card className="mb-4 p-4">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-wide text-ink-400">Delivery cost sharing</p>
        <button onClick={() => setEditing((v) => !v)} className="text-ink-400 hover:text-relay-600" aria-label="Edit delivery cost sharing">
          <Pencil size={14} />
        </button>
      </div>
      <p className="mb-2 text-xs text-ink-400">
        Your share of each delivery fee, split with the customer automatically. Defaults to an even 50/50, since there's no platform cut here to offset. Adjust it if your margins call for a different split.
      </p>
      {editing ? (
        <SubsidyEditor
          initial={catalog.delivery_subsidy_percent}
          onSave={async (percent) => {
            await setDeliverySubsidyPercent(catalogRef, percent);
            await onSaved();
            setEditing(false);
          }}
        />
      ) : (
        <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">
          {catalog.delivery_subsidy_percent > 0 ? `You cover ${catalog.delivery_subsidy_percent}% of delivery` : "Customer covers the full delivery fee"}
        </p>
      )}
    </Card>
  );
}

/// Whether the store's conductor accepts new orders by itself. It still
/// declines any priced from an outdated menu, and works with the app closed.
export function AutoAcceptCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  async function toggle(autoAccept: boolean) {
    setSaving(true);
    try {
      await setAutoAcceptOrders(catalogRef, autoAccept);
      await onSaved();
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card className="mb-4 flex items-start justify-between gap-4 p-4">
      <div>
        <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-400">Accept orders automatically</p>
        <p className="text-xs text-ink-400">
          New orders are accepted as they arrive, even with this app closed. Orders priced from an outdated menu are still declined. Leave it off to accept each order yourself.
        </p>
      </div>
      <Switch checked={catalog.auto_accept_orders} onChange={toggle} disabled={saving} label="Accept orders automatically" />
    </Card>
  );
}

/// The most an order may cost to be left at the door. A customer who
/// chooses the door accepts the risk once it's left; above this, the
/// store's orders are always handed over against the customer's code.
export function LeaveAtDoorCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const limit = catalog.leave_at_door_max_cents;
  return (
    <Card className="mb-4 p-4">
      <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-400">Leaving orders at the door</p>
      <p className="mb-3 text-xs leading-relaxed text-ink-400">
        Customers who choose it accept the risk once the order's left. Above your limit, orders are always handed over with the customer's code.
      </p>
      <LimitEditor key={limit ?? "none"} initialCents={limit} onSave={async (cents) => {
        await setLeaveAtDoorLimit(catalogRef, cents);
        await onSaved();
      }} />
    </Card>
  );
}

/// The smallest order the store takes, before any promo -- network
/// validation refuses a smaller one. A goodie bag is priced on its own.
export function MinimumOrderCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const minimum = catalog.min_order_cents;
  return (
    <Card className="mb-4 p-4">
      <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-400">Minimum order</p>
      <p className="mb-3 text-xs leading-relaxed text-ink-400">Customers see it before they order. Goodie bags aren't affected.</p>
      <LimitEditor key={minimum ?? "none"} initialCents={minimum} placeholder="None" onSave={async (cents) => {
        await setMinimumOrder(catalogRef, cents);
        await onSaved();
      }} />
    </Card>
  );
}

/// How long the store may keep a checked-in driver waiting past an order's
/// ready time before they can leave paid -- its own, within the network's
/// bounds, or the network's. Customers see it at checkout; each order keeps
/// the wait it was placed under.
export function StoreWaitCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const terms = useTerms();
  const [min, max, usual] = [terms.min_store_wait_secs, terms.max_store_wait_secs, terms.store_wait_secs].map((secs) => Math.round(secs / 60));
  const own = catalog.store_wait_minutes;
  const [draft, setDraft] = useState(String(own ?? usual));
  const [saving, setSaving] = useState(false);
  const minutes = Math.round(Number(draft));
  const valid = Number.isFinite(minutes) && minutes >= min && minutes <= max;

  async function save(value: number | null) {
    setSaving(true);
    try {
      await setStoreWait(catalogRef, value);
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-4 p-4">
      <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-400">Driver wait</p>
      <p className="mb-3 text-xs leading-relaxed text-ink-400">
        How long past an order's ready time a checked-in driver waits before they can call you late. Then you pay their fee, the order goes to another driver, and the customer can cancel for a full refund. Customers see it before they order. {own === null ? `You're using the network's ${usual} minutes.` : ""}
      </p>
      <div className="flex items-center gap-2">
        <Input type="number" min={min} max={max} step={5} value={draft} onChange={(e) => setDraft(e.target.value)} suffix="min" className="w-28" />
        <Button loading={saving} disabled={!valid || minutes === own} onClick={() => save(minutes)} className="px-4 py-2 text-xs">
          Save
        </Button>
        {own !== null && (
          <Button variant="ghost" loading={saving} onClick={() => save(null)} className="px-4 py-2 text-xs">
            Use the network's
          </Button>
        )}
      </div>
      {!valid && <p className="mt-2 text-xs text-amber-600">Between {min} and {max} minutes.</p>}
    </Card>
  );
}

/// Busy mode: extra minutes on the store's usual prep time while it's
/// swamped, shown to customers before they order. Off is 0.
export function BusyCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const room = useTerms().max_prep_minutes - catalog.prep_minutes;
  const busy = catalog.busy_extra_minutes > 0;
  const [draft, setDraft] = useState(String(busy ? catalog.busy_extra_minutes : Math.min(catalog.prep_minutes, room)));
  const [saving, setSaving] = useState(false);
  const extra = Math.round(Number(draft));
  const valid = Number.isFinite(extra) && extra >= 1 && extra <= room;

  async function save(minutes: number) {
    setSaving(true);
    try {
      await setBusy(catalogRef, minutes);
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-4 p-4">
      <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-400">Busy</p>
      <p className="mb-3 text-xs leading-relaxed text-ink-400">
        {busy
          ? `You're busy: orders take ${catalog.prep_minutes + catalog.busy_extra_minutes} minutes instead of ${catalog.prep_minutes}. Customers see it before they order.`
          : "Swamped? Add time to your usual prep, and customers see the longer wait before they order."}
      </p>
      <div className="flex items-center gap-2">
        <Input type="number" min={1} max={room} step={5} value={draft} onChange={(e) => setDraft(e.target.value)} suffix="min" className="w-28" />
        <Button loading={saving} disabled={!valid} onClick={() => save(extra)} className="px-4 py-2 text-xs">
          {busy ? "Update" : "I'm busy"}
        </Button>
        {busy && (
          <Button variant="ghost" loading={saving} onClick={() => save(0)} className="px-4 py-2 text-xs">
            Not busy
          </Button>
        )}
      </div>
      {!valid && <p className="mt-2 text-xs text-amber-600">Between 1 and {room} minutes: your prep time plus this can't pass the network's longest.</p>}
    </Card>
  );
}

/// An amount limit, or none. Seeded from the saved limit when it mounts.
function LimitEditor({ initialCents, placeholder = "No limit", onSave }: { initialCents: number | null; placeholder?: string; onSave: (cents: number | null) => Promise<void> }) {
  const [draft, setDraft] = useState(initialCents === null ? "" : String(fromMinorUnits(initialCents)));
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      const dollars = Number(draft);
      await onSave(draft.trim() === "" || !Number.isFinite(dollars) || dollars <= 0 ? null : toMinorUnits(dollars));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="flex items-center gap-2">
      <Input type="number" min={0} step={5} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} prefix={currencySymbol()} className="w-32" />
      <Button loading={saving} onClick={save} className="px-4 py-2 text-xs">
        Save
      </Button>
    </div>
  );
}

/// Seeded from the saved percentage when it mounts.
function SubsidyEditor({ initial, onSave }: { initial: number; onSave: (percent: number) => Promise<void> }) {
  const [draft, setDraft] = useState(String(initial));
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await onSave(Math.min(100, Math.max(0, Math.round(Number(draft || 0)))));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Input type="number" min={0} max={100} step={5} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="50" suffix="%" className="w-24" />
      <Button loading={saving} onClick={save} className="px-4 py-2 text-xs">
        Save
      </Button>
    </div>
  );
}

/// Whether customers can find the store, and the deposit that listing it
/// sets aside -- returned when the listing closes. A closed listing keeps
/// answering the orders it has; it just isn't offered to new customers.
export function ListingCard({ catalogRef }: { catalogRef: Uint8Array }) {
  const stake = useTerms().store_listing_stake;
  const { data: listed, reload } = useResource(`store-listed:${bytesToHex(catalogRef)}`, () => isStoreListed(catalogRef));
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(change: () => Promise<void>) {
    setSaving(true);
    setError(null);
    try {
      await change();
      setConfirming(false);
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  if (listed === undefined) return null;
  return (
    <Card className="mb-4 p-4">
      <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-400">Listing</p>
      <p className="mb-3 text-xs leading-relaxed text-ink-400">
        {listed
          ? `Customers nearby can find this store. Its listing holds a ${formatCents(stake)} deposit, returned if you close it.`
          : `Customers can't find this store, though it still answers the orders it has. Listing it again sets aside a ${formatCents(stake)} deposit.`}
      </p>
      {listed ? (
        confirming ? (
          <div className="flex items-center gap-2">
            <Button variant="danger" loading={saving} onClick={() => act(() => closeListing(catalogRef))} className="px-4 py-2 text-xs">
              Close listing
            </Button>
            <Button variant="ghost" disabled={saving} onClick={() => setConfirming(false)} className="px-4 py-2 text-xs">
              Keep it
            </Button>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setConfirming(true)} className="px-4 py-2 text-xs">
            Close listing…
          </Button>
        )
      ) : (
        <Button loading={saving} onClick={() => act(() => reopenListing(catalogRef))} className="px-4 py-2 text-xs">
          List again
        </Button>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </Card>
  );
}
