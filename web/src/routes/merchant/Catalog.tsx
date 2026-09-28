import { useEffect, useState } from "react";
import { Pencil, Plus, Star, Store } from "lucide-react";
import { publishCatalog, setCatalogOpen, updateCatalogDetails, addMenuItem, updateMenuItem, listMenuItems, getNearbyMerchants } from "../../holochain/zomes/catalog";
import { getReviewsFor } from "../../holochain/zomes/reputation";
import { decodeEntry, actionHash, bytesToHex, bytesEqual } from "../../holochain/decode";
import { myAgentPubKey } from "../../holochain/client";
import { useSession } from "../../store/session";
import { encodeGeohash } from "../../lib/geohash";
import { Button, Card, Spinner } from "../../components/ui";
import { PhotoInput } from "../../components/PhotoInput";
import { StarRating } from "../../components/StarRating";
import { formatCents } from "../../lib/format";
import type { MenuItem, MerchantCatalog, Review } from "../../holochain/types";

interface ItemRow {
  hash: Uint8Array;
  item: MenuItem;
}

const EMPTY_ITEM_FORM = { name: "", price: 10, description: "", photo_data_uri: "", category: "", dietary_tags: "" };

export function MerchantCatalog() {
  const location = useSession((s) => s.location);
  const [catalog, setCatalog] = useState<MerchantCatalog | null>(null);
  const [catalogHash, setCatalogHash] = useState<Uint8Array | null>(null);
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [businessName, setBusinessName] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const [detailsDraft, setDetailsDraft] = useState({ description: "", cuisine_type: "", banner_data_uri: "", phone: "", address_line: "", hours_open: "", hours_close: "" });
  const [savingDetails, setSavingDetails] = useState(false);
  const [itemForm, setItemForm] = useState(EMPTY_ITEM_FORM);
  const [editingItemHash, setEditingItemHash] = useState<string | null>(null);
  const [showAddItem, setShowAddItem] = useState(false);
  const [savingItem, setSavingItem] = useState(false);

  async function load() {
    const me = myAgentPubKey();
    const page = await getNearbyMerchants(encodeGeohash(location.lat, location.lon));
    const mine = page.catalogs.find((r) => bytesEqual(decodeEntry<MerchantCatalog>(r).owner, me));
    if (mine) {
      const decoded = decodeEntry<MerchantCatalog>(mine);
      setCatalog(decoded);
      setCatalogHash(actionHash(mine));
      setDetailsDraft({
        description: decoded.description,
        cuisine_type: decoded.cuisine_type,
        banner_data_uri: decoded.banner_data_uri,
        phone: decoded.phone,
        address_line: decoded.address_line,
        hours_open: decoded.hours_open,
        hours_close: decoded.hours_close,
      });
      const itemsPage = await listMenuItems(actionHash(mine));
      setItems(itemsPage.items.map((r) => ({ hash: actionHash(r), item: decodeEntry<MenuItem>(r) })));
      getReviewsFor(decoded.owner).then((records) => setReviews(records.map((r) => decodeEntry<Review>(r))));
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function publish() {
    if (!businessName.trim()) return;
    setPublishing(true);
    try {
      await publishCatalog({ business_name: businessName.trim(), location });
      await load();
    } finally {
      setPublishing(false);
    }
  }

  async function toggleOpen() {
    if (!catalogHash || !catalog) return;
    await setCatalogOpen(catalogHash, !catalog.is_open);
    await load();
  }

  async function saveDetails() {
    if (!catalogHash) return;
    setSavingDetails(true);
    try {
      await updateCatalogDetails(catalogHash, detailsDraft);
      await load();
      setEditingDetails(false);
    } finally {
      setSavingDetails(false);
    }
  }

  function startEditItem(row: ItemRow) {
    setEditingItemHash(bytesToHex(row.hash));
    setItemForm({
      name: row.item.name,
      price: row.item.price_cents / 100,
      description: row.item.description,
      photo_data_uri: row.item.photo_data_uri,
      category: row.item.category,
      dietary_tags: row.item.dietary_tags.join(", "),
    });
    setShowAddItem(true);
  }

  function resetItemForm() {
    setItemForm(EMPTY_ITEM_FORM);
    setEditingItemHash(null);
    setShowAddItem(false);
  }

  async function saveItem() {
    if (!catalogHash || !itemForm.name.trim()) return;
    setSavingItem(true);
    const tags = itemForm.dietary_tags.split(",").map((t) => t.trim()).filter(Boolean);
    try {
      if (editingItemHash) {
        const row = items?.find((r) => bytesToHex(r.hash) === editingItemHash);
        if (row) {
          await updateMenuItem(row.hash, {
            ...row.item,
            name: itemForm.name.trim(),
            price_cents: Math.round(itemForm.price * 100),
            description: itemForm.description,
            photo_data_uri: itemForm.photo_data_uri,
            category: itemForm.category,
            dietary_tags: tags,
          });
        }
      } else {
        await addMenuItem({
          catalog_ref: catalogHash,
          name: itemForm.name.trim(),
          price_cents: Math.round(itemForm.price * 100),
          available: true,
          description: itemForm.description,
          photo_data_uri: itemForm.photo_data_uri,
          category: itemForm.category,
          dietary_tags: tags,
        });
      }
      resetItemForm();
      await load();
    } finally {
      setSavingItem(false);
    }
  }

  async function toggleAvailable(row: ItemRow) {
    await updateMenuItem(row.hash, { ...row.item, available: !row.item.available });
    await load();
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-ink-300">
        <Spinner />
      </div>
    );
  }

  if (!catalog || !catalogHash) {
    return (
      <div className="px-4 pt-8">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-relay-100 dark:bg-relay-900/30 text-relay-600">
            <Store size={22} />
          </div>
          <h1 className="text-lg font-black text-ink-900 dark:text-ink-50">Publish your storefront</h1>
          <p className="text-xs text-ink-400">This creates a real, discoverable catalog entry for your current location.</p>
        </div>
        <Card className="flex flex-col gap-3 p-5">
          <input
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="Cara's Kitchen"
            className="rounded-xl border border-ink-200 dark:border-ink-700 bg-transparent px-3.5 py-2.5 text-sm outline-none focus:border-relay-400"
          />
          <Button loading={publishing} disabled={!businessName.trim()} onClick={publish}>
            Publish catalog
          </Button>
        </Card>
      </div>
    );
  }

  const avgRating = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
  const grouped = new Map<string, ItemRow[]>();
  for (const row of items ?? []) {
    const key = row.item.category || "Menu";
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return (
    <div className="pb-8">
      {catalog.banner_data_uri && <img src={catalog.banner_data_uri} alt="" className="h-32 w-full object-cover" />}
      <div className="px-4 pt-4">
        <div className="mb-1 flex items-center justify-between">
          <h1 className="text-xl font-black text-ink-900 dark:text-ink-50">{catalog.business_name}</h1>
          <Button variant={catalog.is_open ? "secondary" : "primary"} className="px-3 py-1.5 text-xs" onClick={toggleOpen}>
            {catalog.is_open ? "Open" : "Closed"} · toggle
          </Button>
        </div>
        {reviews.length > 0 && <StarRating value={avgRating} count={reviews.length} />}

        <Card className="my-4 p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wide text-ink-400">Storefront details</p>
            <button onClick={() => setEditingDetails((v) => !v)} className="text-ink-400 hover:text-relay-600">
              <Pencil size={14} />
            </button>
          </div>
          {editingDetails ? (
            <div className="flex flex-col gap-2">
              <PhotoInput value={detailsDraft.banner_data_uri} onChange={(v) => setDetailsDraft((d) => ({ ...d, banner_data_uri: v }))} shape="banner" />
              <textarea
                value={detailsDraft.description}
                onChange={(e) => setDetailsDraft((d) => ({ ...d, description: e.target.value }))}
                rows={2}
                placeholder="Describe your restaurant"
                className="resize-none rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
              />
              <input
                value={detailsDraft.cuisine_type}
                onChange={(e) => setDetailsDraft((d) => ({ ...d, cuisine_type: e.target.value }))}
                placeholder="Cuisine (e.g. Cuban, Italian)"
                className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
              />
              <input
                value={detailsDraft.address_line}
                onChange={(e) => setDetailsDraft((d) => ({ ...d, address_line: e.target.value }))}
                placeholder="Address"
                className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
              />
              <input
                value={detailsDraft.phone}
                onChange={(e) => setDetailsDraft((d) => ({ ...d, phone: e.target.value }))}
                placeholder="Phone"
                className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
              />
              <div className="flex gap-2">
                <input
                  value={detailsDraft.hours_open}
                  onChange={(e) => setDetailsDraft((d) => ({ ...d, hours_open: e.target.value }))}
                  placeholder="Opens (09:00)"
                  className="flex-1 rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
                />
                <input
                  value={detailsDraft.hours_close}
                  onChange={(e) => setDetailsDraft((d) => ({ ...d, hours_close: e.target.value }))}
                  placeholder="Closes (22:00)"
                  className="flex-1 rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
                />
              </div>
              <Button loading={savingDetails} onClick={saveDetails} className="py-2 text-xs">
                Save
              </Button>
            </div>
          ) : (
            <div className="text-sm text-ink-600 dark:text-ink-300">
              <p>{catalog.description || "No description yet."}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-400">
                {catalog.cuisine_type && <span>{catalog.cuisine_type}</span>}
                {catalog.address_line && <span>{catalog.address_line}</span>}
                {catalog.phone && <span>{catalog.phone}</span>}
                {(catalog.hours_open || catalog.hours_close) && (
                  <span>
                    {catalog.hours_open || "?"}–{catalog.hours_close || "?"}
                  </span>
                )}
              </div>
            </div>
          )}
        </Card>

        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-400">Menu</p>
          <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => (showAddItem ? resetItemForm() : setShowAddItem(true))}>
            <Plus size={14} /> {showAddItem ? "Cancel" : "Add item"}
          </Button>
        </div>

        {showAddItem && (
          <Card className="mb-4 flex flex-col gap-2 p-4">
            <div className="flex gap-3">
              <PhotoInput value={itemForm.photo_data_uri} onChange={(v) => setItemForm((f) => ({ ...f, photo_data_uri: v }))} shape="circle" className="shrink-0" />
              <div className="flex flex-1 flex-col gap-2">
                <input
                  value={itemForm.name}
                  onChange={(e) => setItemForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Item name"
                  className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
                />
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={itemForm.price}
                  onChange={(e) => setItemForm((f) => ({ ...f, price: Number(e.target.value) }))}
                  placeholder="Price ($)"
                  className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
                />
              </div>
            </div>
            <textarea
              value={itemForm.description}
              onChange={(e) => setItemForm((f) => ({ ...f, description: e.target.value }))}
              rows={2}
              placeholder="Description"
              className="resize-none rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
            />
            <input
              value={itemForm.category}
              onChange={(e) => setItemForm((f) => ({ ...f, category: e.target.value }))}
              placeholder="Category (e.g. Appetizers)"
              className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
            />
            <input
              value={itemForm.dietary_tags}
              onChange={(e) => setItemForm((f) => ({ ...f, dietary_tags: e.target.value }))}
              placeholder="Dietary tags, comma separated (Vegetarian, Spicy)"
              className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
            />
            <Button loading={savingItem} disabled={!itemForm.name.trim()} onClick={saveItem} className="py-2 text-xs">
              {editingItemHash ? "Save changes" : "Add to menu"}
            </Button>
          </Card>
        )}

        {items?.length === 0 && !showAddItem && <p className="rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 text-center text-sm text-ink-400">No menu items yet.</p>}

        {[...grouped.entries()].map(([category, rows]) => (
          <div key={category} className="mb-4">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">{category}</p>
            <div className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900">
              {rows.map((row) => (
                <div key={bytesToHex(row.hash)} className="flex items-center gap-3 p-4">
                  {row.item.photo_data_uri && <img src={row.item.photo_data_uri} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{row.item.name}</p>
                    {row.item.description && <p className="truncate text-xs text-ink-400">{row.item.description}</p>}
                    <p className="text-sm text-ink-500">{formatCents(row.item.price_cents)}</p>
                  </div>
                  <button onClick={() => toggleAvailable(row)} className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${row.item.available ? "bg-presence-500/15 text-presence-600" : "bg-ink-100 text-ink-400"}`}>
                    {row.item.available ? "Available" : "Sold out"}
                  </button>
                  <button onClick={() => startEditItem(row)} className="text-ink-400 hover:text-relay-600">
                    <Pencil size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}

        {reviews.length > 0 && (
          <Card className="p-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
              <Star size={13} /> Reviews
            </p>
            <div className="flex flex-col gap-3">
              {reviews.map((r, i) => (
                <div key={i} className="border-b border-ink-100 dark:border-ink-800 pb-2 last:border-0 last:pb-0">
                  <StarRating value={r.rating} size={12} />
                  {r.comment && <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{r.comment}</p>}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
