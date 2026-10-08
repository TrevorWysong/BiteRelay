import { useState } from "react";
import { Pencil } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { setAutoAcceptOrders, setDeliverySubsidyPercent, updateCatalogDetails } from "../../../holochain/zomes/catalog";
import { formatCatalogAddress } from "../../../lib/format";
import { Button, Card, Field, Input, Switch, Textarea } from "../../../components/ui";
import { PhotoInput } from "../../../components/PhotoInput";
import { SplitAddressFields } from "../../../components/SplitAddressFields";
import type { MerchantCatalog } from "../../../holochain/types";

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
                await updateCatalogDetails(catalogRef, draft);
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
              {(catalog.hours_open || catalog.hours_close) && (
                <span>
                  {catalog.hours_open || "?"}–{catalog.hours_close || "?"}
                </span>
              )}
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
    hours_open: catalog.hours_open,
    hours_close: catalog.hours_close,
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
        <Textarea value={draft.description} onChange={(e) => set({ description: e.target.value })} rows={2} placeholder="Describe your restaurant" />
      </Field>
      <Field label="Cuisine">
        <Input value={draft.cuisine_type} onChange={(e) => set({ cuisine_type: e.target.value })} placeholder="Cuban, Italian, …" />
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
        <Input value={draft.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="(555) 555-0100" />
      </Field>
      <div className="flex gap-2">
        <Field label="Opens">
          <Input value={draft.hours_open} onChange={(e) => set({ hours_open: e.target.value })} placeholder="09:00" />
        </Field>
        <Field label="Closes">
          <Input value={draft.hours_close} onChange={(e) => set({ hours_close: e.target.value })} placeholder="22:00" />
        </Field>
      </div>
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
