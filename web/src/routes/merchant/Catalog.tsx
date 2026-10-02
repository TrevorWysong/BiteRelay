import { useEffect, useState } from "react";
import { Pencil, Plus, Star, Store, Tag } from "lucide-react";
import {
  publishCatalog,
  setCatalogOpen,
  updateCatalogDetails,
  setDeliverySubsidyPercent,
  addMenuItem,
  updateMenuItem,
  listMenuItems,
  getNearbyMerchants,
  createPromoCode,
  setPromoCodeActive,
  listPromoCodesForCatalog,
} from "../../holochain/zomes/catalog";
import { getReviewsFor } from "../../holochain/zomes/reputation";
import { decodeEntry, actionHash, bytesToHex, hexToBytes, bytesEqual } from "../../holochain/decode";
import { myAgentPubKey } from "../../holochain/client";
import { useSession } from "../../store/session";
import { encodeGeohash } from "../../lib/geohash";
import { Button, Card, Spinner } from "../../components/ui";
import { PhotoInput } from "../../components/PhotoInput";
import { StarRating } from "../../components/StarRating";
import { formatCents } from "../../lib/format";
import { describeRequirement, describeReward } from "../../lib/promotions";
import type { MenuItem, MerchantCatalog, PromoCode, PromoRequirement, PromoReward, Review } from "../../holochain/types";

interface ItemRow {
  hash: Uint8Array;
  item: MenuItem;
}

interface PromoRow {
  hash: Uint8Array;
  promo: PromoCode;
}

const EMPTY_ITEM_FORM = { name: "", price: 10, description: "", photo_data_uri: "", category: "", dietary_tags: "" };

// Requirement/reward are chosen independently in the UI (two separate
// dropdowns), matching how `PromoRequirement`/`PromoReward` are two
// independent enums on the Rust side -- a plain code, "spend $X get item Y
// free," and buy-X-get-Y-free/BOGO are all just one requirement kind paired
// with one reward kind, never a hardcoded "promo type" branch anywhere in
// this form.
type RequirementKind = "none" | "minSpend" | "minItemQty";
type RewardKind = "percentOffSubtotal" | "flatOffSubtotal" | "freeItem" | "percentOffItem";

const EMPTY_PROMO_FORM = {
  code: "",
  requirementKind: "none" as RequirementKind,
  requirementAmount: 20, // dollars (minSpend) or units (minItemQty)
  requirementItemHex: "",
  rewardKind: "percentOffSubtotal" as RewardKind,
  rewardAmount: 10, // percent (percentOff*) or dollars (flatOffSubtotal)
  rewardItemHex: "",
  rewardQuantity: 1,
};

function buildRequirement(form: typeof EMPTY_PROMO_FORM): PromoRequirement | null {
  switch (form.requirementKind) {
    case "none":
      return "None";
    case "minSpend":
      return { MinimumSpend: Math.max(1, Math.round(form.requirementAmount * 100)) };
    case "minItemQty":
      if (!form.requirementItemHex) return null;
      return { MinimumItemQuantity: { item_ref: hexToBytes(form.requirementItemHex), quantity: Math.max(1, Math.round(form.requirementAmount)) } };
  }
}

function buildReward(form: typeof EMPTY_PROMO_FORM): PromoReward | null {
  switch (form.rewardKind) {
    case "percentOffSubtotal":
      return { PercentOffSubtotal: Math.min(100, Math.max(1, Math.round(form.rewardAmount))) };
    case "flatOffSubtotal":
      return { FlatOffSubtotal: Math.max(1, Math.round(form.rewardAmount * 100)) };
    case "freeItem":
      if (!form.rewardItemHex) return null;
      return { FreeItem: { item_ref: hexToBytes(form.rewardItemHex), quantity: Math.max(1, Math.round(form.rewardQuantity)) } };
    case "percentOffItem":
      if (!form.rewardItemHex) return null;
      return {
        PercentOffItem: {
          item_ref: hexToBytes(form.rewardItemHex),
          percent: Math.min(100, Math.max(1, Math.round(form.rewardAmount))),
          quantity: Math.max(1, Math.round(form.rewardQuantity)),
        },
      };
  }
}

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
  const [editingSubsidy, setEditingSubsidy] = useState(false);
  const [subsidyDraft, setSubsidyDraft] = useState("50");
  const [savingSubsidy, setSavingSubsidy] = useState(false);
  const [itemForm, setItemForm] = useState(EMPTY_ITEM_FORM);
  const [editingItemHash, setEditingItemHash] = useState<string | null>(null);
  const [showAddItem, setShowAddItem] = useState(false);
  const [savingItem, setSavingItem] = useState(false);
  const [promos, setPromos] = useState<PromoRow[]>([]);
  const [showAddPromo, setShowAddPromo] = useState(false);
  const [promoForm, setPromoForm] = useState(EMPTY_PROMO_FORM);
  const [savingPromo, setSavingPromo] = useState(false);
  const [togglingPromo, setTogglingPromo] = useState<string | null>(null);

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
      setSubsidyDraft(decoded.delivery_subsidy_percent.toString());
      const itemsPage = await listMenuItems(actionHash(mine));
      setItems(itemsPage.items.map((r) => ({ hash: actionHash(r), item: decodeEntry<MenuItem>(r) })));
      getReviewsFor(decoded.owner).then((records) => setReviews(records.map((r) => decodeEntry<Review>(r))));
      const promoRecords = await listPromoCodesForCatalog(actionHash(mine));
      setPromos(promoRecords.map((r) => ({ hash: actionHash(r), promo: decodeEntry<PromoCode>(r) })));
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

  async function saveSubsidy() {
    if (!catalogHash) return;
    setSavingSubsidy(true);
    try {
      await setDeliverySubsidyPercent(catalogHash, Math.min(100, Math.max(0, Math.round(Number(subsidyDraft || 0)))));
      await load();
      setEditingSubsidy(false);
    } finally {
      setSavingSubsidy(false);
    }
  }

  async function savePromo() {
    if (!catalogHash || !promoForm.code.trim()) return;
    const requirement = buildRequirement(promoForm);
    const reward = buildReward(promoForm);
    if (!requirement || !reward) return;
    setSavingPromo(true);
    try {
      await createPromoCode({
        catalog_ref: catalogHash,
        code: promoForm.code.trim().toUpperCase(),
        requirement,
        reward,
      });
      await load();
      setShowAddPromo(false);
      setPromoForm(EMPTY_PROMO_FORM);
    } finally {
      setSavingPromo(false);
    }
  }

  async function togglePromo(row: PromoRow) {
    setTogglingPromo(bytesToHex(row.hash));
    try {
      await setPromoCodeActive(row.hash, !row.promo.active);
      await load();
    } finally {
      setTogglingPromo(null);
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
  const itemNameByHex = new Map((items ?? []).map((row) => [bytesToHex(row.hash), row.item.name]));
  const itemName = (hex: string) => itemNameByHex.get(hex);
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

        <Card className="mb-4 p-4">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wide text-ink-400">Delivery cost sharing</p>
            <button onClick={() => setEditingSubsidy((v) => !v)} className="text-ink-400 hover:text-relay-600">
              <Pencil size={14} />
            </button>
          </div>
          <p className="mb-2 text-xs text-ink-400">
            Your share of each delivery's fee, split proportionally with the customer at settlement -- defaults to an even 50/50, since you're not paying a platform commission here. Adjust if your margins need a different split.
          </p>
          {editingSubsidy ? (
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={subsidyDraft}
                onChange={(e) => setSubsidyDraft(e.target.value)}
                placeholder="50"
                className="w-24 rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
              />
              <span className="text-sm text-ink-400">%</span>
              <Button loading={savingSubsidy} onClick={saveSubsidy} className="px-4 py-2 text-xs">
                Save
              </Button>
            </div>
          ) : (
            <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">
              {catalog.delivery_subsidy_percent > 0 ? `You cover ${catalog.delivery_subsidy_percent}% of delivery` : "You cover 0% -- fully customer-paid"}
            </p>
          )}
        </Card>

        <Card className="mb-4 p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
              <Tag size={13} /> Promo codes
            </p>
            <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => setShowAddPromo((v) => !v)}>
              <Plus size={14} /> {showAddPromo ? "Cancel" : "New code"}
            </Button>
          </div>
          {showAddPromo && (
            <div className="mb-3 flex flex-col gap-3 rounded-xl bg-ink-50 dark:bg-ink-800/60 p-3">
              <input
                value={promoForm.code}
                onChange={(e) => setPromoForm((f) => ({ ...f, code: e.target.value }))}
                placeholder="CODE (e.g. WELCOME10)"
                className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm font-mono outline-none focus:border-relay-400"
              />

              <div>
                <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-ink-400">Requirement</p>
                <div className="flex items-center gap-2">
                  <select
                    value={promoForm.requirementKind}
                    onChange={(e) => setPromoForm((f) => ({ ...f, requirementKind: e.target.value as RequirementKind }))}
                    className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-2 py-2 text-sm"
                  >
                    <option value="none">None -- always eligible</option>
                    <option value="minSpend">Minimum spend</option>
                    <option value="minItemQty">Minimum quantity of an item</option>
                  </select>
                  {promoForm.requirementKind === "minSpend" && (
                    <input
                      type="number"
                      min={0.01}
                      step={0.5}
                      value={promoForm.requirementAmount}
                      onChange={(e) => setPromoForm((f) => ({ ...f, requirementAmount: Number(e.target.value) }))}
                      placeholder="$"
                      className="w-24 rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm"
                    />
                  )}
                </div>
                {promoForm.requirementKind === "minItemQty" && (
                  <div className="mt-2 flex items-center gap-2">
                    <select
                      value={promoForm.requirementItemHex}
                      onChange={(e) => setPromoForm((f) => ({ ...f, requirementItemHex: e.target.value }))}
                      className="flex-1 rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-2 py-2 text-sm"
                    >
                      <option value="">Select an item...</option>
                      {(items ?? []).map((row) => (
                        <option key={bytesToHex(row.hash)} value={bytesToHex(row.hash)}>
                          {row.item.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={promoForm.requirementAmount}
                      onChange={(e) => setPromoForm((f) => ({ ...f, requirementAmount: Number(e.target.value) }))}
                      placeholder="Qty"
                      className="w-20 rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm"
                    />
                  </div>
                )}
              </div>

              <div>
                <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-ink-400">Reward</p>
                <div className="flex items-center gap-2">
                  <select
                    value={promoForm.rewardKind}
                    onChange={(e) => setPromoForm((f) => ({ ...f, rewardKind: e.target.value as RewardKind }))}
                    className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-2 py-2 text-sm"
                  >
                    <option value="percentOffSubtotal">% off order</option>
                    <option value="flatOffSubtotal">$ off order</option>
                    <option value="freeItem">Free item (e.g. BOGO)</option>
                    <option value="percentOffItem">% off an item</option>
                  </select>
                  {(promoForm.rewardKind === "percentOffSubtotal" || promoForm.rewardKind === "flatOffSubtotal" || promoForm.rewardKind === "percentOffItem") && (
                    <input
                      type="number"
                      min={promoForm.rewardKind === "flatOffSubtotal" ? 0.01 : 1}
                      max={promoForm.rewardKind === "flatOffSubtotal" ? undefined : 100}
                      step={promoForm.rewardKind === "flatOffSubtotal" ? 0.5 : 1}
                      value={promoForm.rewardAmount}
                      onChange={(e) => setPromoForm((f) => ({ ...f, rewardAmount: Number(e.target.value) }))}
                      className="w-24 rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm"
                    />
                  )}
                </div>
                {(promoForm.rewardKind === "freeItem" || promoForm.rewardKind === "percentOffItem") && (
                  <div className="mt-2 flex items-center gap-2">
                    <select
                      value={promoForm.rewardItemHex}
                      onChange={(e) => setPromoForm((f) => ({ ...f, rewardItemHex: e.target.value }))}
                      className="flex-1 rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-2 py-2 text-sm"
                    >
                      <option value="">Select an item...</option>
                      {(items ?? []).map((row) => (
                        <option key={bytesToHex(row.hash)} value={bytesToHex(row.hash)}>
                          {row.item.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={promoForm.rewardQuantity}
                      onChange={(e) => setPromoForm((f) => ({ ...f, rewardQuantity: Number(e.target.value) }))}
                      placeholder="Qty"
                      className="w-20 rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm"
                    />
                  </div>
                )}
              </div>

              <Button
                loading={savingPromo}
                disabled={!promoForm.code.trim() || !buildRequirement(promoForm) || !buildReward(promoForm)}
                onClick={savePromo}
                className="py-2 text-xs"
              >
                Create
              </Button>
            </div>
          )}
          {promos.length === 0 && !showAddPromo ? (
            <p className="text-sm text-ink-400">No promo codes yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {promos.map((row) => (
                <div key={bytesToHex(row.hash)} className="flex items-center justify-between rounded-lg bg-ink-50 dark:bg-ink-800/60 px-3 py-2">
                  <div>
                    <p className="font-mono text-sm font-semibold text-ink-900 dark:text-ink-50">{row.promo.code}</p>
                    <p className="text-xs text-ink-400">
                      {describeRequirement(row.promo.requirement, itemName)} -- {describeReward(row.promo.reward, itemName)}
                    </p>
                  </div>
                  <Button
                    variant={row.promo.active ? "secondary" : "ghost"}
                    className="px-3 py-1.5 text-xs"
                    loading={togglingPromo === bytesToHex(row.hash)}
                    onClick={() => togglePromo(row)}
                  >
                    {row.promo.active ? "Active" : "Inactive"}
                  </Button>
                </div>
              ))}
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
