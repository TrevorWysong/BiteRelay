import { useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Clock, Heart, MapPin, PackageOpen, Phone, Plus, ShoppingBag, Star } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { getCatalog, listGoodieBagsForCatalog, claimGoodieBag, type FulfillmentInput } from "../../holochain/zomes/catalog";
import { averageRating, getRatingSummary, getReputationSummary, getReviewsFor, getItemRatingSummary, type ItemRatingSummary } from "../../holochain/zomes/reputation";
import { useResource } from "../../lib/useResource";
import { decodeEntry, hexToBytes, bytesToHex } from "../../holochain/decode";
import { useSession } from "../../store/session";
import { useCart } from "../../store/cart";
import { formatCatalogAddress, formatCents, toMinorUnits, currencySymbol } from "../../lib/format";
import { describeError } from "../../lib/errors";
import { Button, Chip, ChipRow, Input, Skeleton, StatNumber } from "../../components/ui";
import { AddressSearch } from "../../components/AddressSearch";
import { StarRating } from "../../components/StarRating";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import { fetchMenu, groupByCategory } from "../../lib/menu";
import { useFavorites } from "../../lib/useFavorites";
import type { ItemRow } from "../../lib/menu";
import type { GeoPoint, MerchantCatalog, Review, GoodieBag, Timestamp } from "../../holochain/types";
import { POLL } from "../../lib/poll";
import { useClock } from "../../lib/useClock";
import { storeStatus } from "../../lib/storeHours";

interface BagRow {
  hash: Uint8Array;
  bag: GoodieBag;
}

/// Polled for the same reason Browse.tsx's list is -- a menu item added
/// moments ago may not have gossiped to whatever peer answers this read
/// yet, and a customer already sitting on this page shouldn't need to
/// navigate away and back for it to show up.

interface StoreMenu {
  catalog: MerchantCatalog;
  items: ItemRow[];
  bags: BagRow[];
}

async function fetchStoreMenu(catalogHash: Uint8Array): Promise<StoreMenu> {
  const [record, items, bagViews] = await Promise.all([getCatalog(catalogHash), fetchMenu(catalogHash), listGoodieBagsForCatalog(catalogHash)]);
  // Same as Browse.tsx's strip: drops a bag that closed since the last poll.
  const now = Date.now() * 1000;
  return {
    catalog: decodeEntry<MerchantCatalog>(record),
    items,
    bags: bagViews.map((v) => ({ hash: v.original_action, bag: decodeEntry<GoodieBag>(v.record) })).filter((r) => r.bag.pickup_window_end > now),
  };
}

/// Keyed by the store in the URL, so moving from one store page to another
/// mounts a fresh page -- no state (reviews, claim forms, filters) can carry
/// over from the previous store.
export function MerchantDetail() {
  const { hash } = useParams<{ hash: string }>();
  if (!hash) return null;
  return <StorePage key={hash} hash={hash} />;
}

function StorePage({ hash }: { hash: string }) {
  const navigate = useNavigate();
  // A card click passes the catalog it already has, so the header renders
  // instantly; the fetch below replaces it with the live version (and is
  // the only source when arriving via a direct URL/refresh).
  const routerState = useLocation().state as { catalog?: MerchantCatalog } | null;
  const location = useSession((s) => s.location);
  const cart = useCart();
  const catalogHash = useMemo(() => hexToBytes(hash), [hash]);
  const { data: menu } = useResource(`store-menu:${hash}`, () => fetchStoreMenu(catalogHash), { pollMs: POLL.slow });
  const catalog = menu?.catalog ?? routerState?.catalog ?? null;
  const now = useClock();
  const status = catalog ? storeStatus(catalog, now) : null;
  const items = menu?.items ?? null;
  const bags = menu?.bags ?? [];
  // Bounded by the menu page itself (a merchant's own menu, already capped
  // -- see list_menu_items' own pagination). Keyed by the exact item set,
  // so a newly added item gets its rating read too.
  const itemsKey = items ? `item-ratings:${items.map((row) => bytesToHex(row.hash)).join(",")}` : null;
  const { data: itemRatings = {} } = useResource<Record<string, ItemRatingSummary>>(itemsKey, async () => {
    const entries = await Promise.all(
      (items ?? []).map(async (row) => [bytesToHex(row.hash), await getItemRatingSummary(row.hash).catch(() => ({ count: 0, rating_sum: 0 }))] as const),
    );
    return Object.fromEntries(entries);
  });
  // This store's own rating and reviews -- keyed by the store, not its
  // owner, so a multi-store owner's other locations (or their driving)
  // never bleed into this page.
  const { data: rating } = useResource(`store-rating:${hash}`, () => getRatingSummary({ Store: catalogHash }));
  // How it treats drivers: times it kept one waiting (each refunded its
  // customer), and drivers' reports it wouldn't check them in.
  const { data: record = null } = useResource(`store-record:${hash}`, () => getReputationSummary({ Store: catalogHash }));
  const { data: reviewFeed, mutate: mutateReviews } = useResource<{ reviews: Review[]; before: Timestamp | null }>(`store-reviews:${hash}`, () =>
    getReviewsFor({ Store: catalogHash }).then((page) => ({ reviews: page.reviews.map((r) => decodeEntry<Review>(r)), before: page.next_before })),
  );
  const reviews = reviewFeed?.reviews ?? [];
  const reviewsBefore = reviewFeed?.before ?? null;
  const [loadingMoreReviews, setLoadingMoreReviews] = useState(false);
  const { favoritesHex, toggleFavorite } = useFavorites();
  const favorited = favoritesHex.has(hash);
  const [claimingBagHex, setClaimingBagHex] = useState<string | null>(null);
  const [claimFulfillment, setClaimFulfillment] = useState<"Pickup" | "Delivery">("Pickup");
  const [claimDropoff, setClaimDropoff] = useState<GeoPoint>(location);
  const [claimFee, setClaimFee] = useState(5);
  const [submittingClaim, setSubmittingClaim] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimedBagHexes, setClaimedBagHexes] = useState<Set<string>>(new Set());
  const [dietaryFilter, setDietaryFilter] = useState<string[]>([]);

  async function loadMoreReviews() {
    if (reviewsBefore === null) return;
    setLoadingMoreReviews(true);
    try {
      const page = await getReviewsFor({ Store: catalogHash }, reviewsBefore);
      mutateReviews((prev) => ({ reviews: [...(prev?.reviews ?? []), ...page.reviews.map((r) => decodeEntry<Review>(r))], before: page.next_before }));
    } finally {
      setLoadingMoreReviews(false);
    }
  }

  function openClaim(row: BagRow) {
    const hex = bytesToHex(row.hash);
    setClaimingBagHex(claimingBagHex === hex ? null : hex);
    setClaimFulfillment(row.bag.supports_pickup ? "Pickup" : "Delivery");
    setClaimDropoff(location);
    setClaimFee(5);
    setClaimError(null);
  }

  async function submitClaim(row: BagRow) {
    setSubmittingClaim(true);
    setClaimError(null);
    try {
      const fulfillment: FulfillmentInput =
        claimFulfillment === "Pickup" ? "Pickup" : { Delivery: { dropoff: claimDropoff, max_delivery_fee: toMinorUnits(claimFee) } };
      await claimGoodieBag(row.hash, fulfillment);
      setClaimedBagHexes((prev) => new Set(prev).add(bytesToHex(row.hash)));
      setClaimingBagHex(null);
    } catch (err) {
      setClaimError(describeError(err));
    } finally {
      setSubmittingClaim(false);
    }
  }

  // Scoped to this one restaurant's own menu, not a union across every
  // nearby restaurant -- a per-merchant menu is naturally small and bounded,
  // unlike the metro-area-wide tag set a Browse-screen version of this
  // filter would have to show (see MerchantCatalog.dietary_tags' own doc
  // comment: that field exists for a different purpose, denormalized
  // discovery-level signal, not this screen's filter). Kept above the
  // loading early-return below -- hooks after it would only run once
  // `items` loads, changing the hook count between renders and crashing.
  const dietaryTags = useMemo(() => {
    const set = new Set<string>();
    items?.forEach((row) => (row.item.dietary_tags ?? []).forEach((t) => set.add(t)));
    return [...set].sort();
  }, [items]);
  const filteredItems = useMemo(() => {
    if (dietaryFilter.length === 0) return items ?? [];
    return (items ?? []).filter((row) => dietaryFilter.some((tag) => (row.item.dietary_tags ?? []).includes(tag)));
  }, [items, dietaryFilter]);

  if (!catalog || !items) {
    return (
      <div className="pb-24">
        <Skeleton className="h-40 w-full rounded-none" />
        <div className="px-4 pt-4">
          <Skeleton className="h-6 w-2/3 mb-2" />
          <Skeleton className="h-4 w-1/3 mb-6" />
          <Skeleton className="h-24 w-full mb-3" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  const cartCount = cart.lines.reduce((n, l) => n + l.quantity, 0);
  const avgRating = rating ? averageRating(rating) : null;
  const grouped = groupByCategory(filteredItems);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="pb-24">
      <div className="relative h-40">
        {catalog.banner_data_uri ? (
          <img src={catalog.banner_data_uri} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center bg-gradient-to-br from-relay-400 to-relay-600 text-5xl">🍽️</div>
        )}
        <motion.button whileTap={{ scale: 0.9 }} onClick={() => navigate(-1)} className="absolute left-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-white/90 shadow backdrop-blur-sm">
          <ArrowLeft size={18} className="text-ink-900" />
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={() => toggleFavorite(catalogHash)}
          className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-white/90 shadow backdrop-blur-sm"
        >
          <Heart size={18} className="text-red-500" fill={favorited ? "currentColor" : "none"} />
        </motion.button>
      </div>

      <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4">
        <motion.h1 variants={fadeSlideUp} className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">{catalog.business_name}</motion.h1>
        {catalog.description && <p className="mt-1 text-sm text-ink-500">{catalog.description}</p>}

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-400">
          {avgRating !== null && rating && <StarRating value={avgRating} count={rating.count} />}
          <span className={status?.open ? "flex items-center gap-1 font-semibold text-presence-600" : "flex items-center gap-1 font-semibold text-red-500"}>
            <Clock size={12} />
            {status?.label}
          </span>
          {catalog.cuisine_type && <span>{catalog.cuisine_type}</span>}
          {catalog.busy_extra_minutes > 0 && <span className="font-semibold text-amber-600">Busy · about {catalog.prep_minutes + catalog.busy_extra_minutes} min to prepare</span>}
          {record && record.late_count > 0 && <span className="font-semibold text-amber-600">Kept drivers waiting {record.late_count}×</span>}
          {record && record.check_in_refused_count > 0 && <span className="font-semibold text-amber-600">{record.check_in_refused_count} driver report{record.check_in_refused_count === 1 ? "" : "s"}</span>}
          {catalog.min_order_cents !== null && <span>{formatCents(catalog.min_order_cents)} minimum</span>}
          {formatCatalogAddress(catalog) && (
            <span className="flex items-center gap-1">
              <MapPin size={12} /> {formatCatalogAddress(catalog)}
            </span>
          )}
          {catalog.phone && (
            <span className="flex items-center gap-1">
              <Phone size={12} /> {catalog.phone}
            </span>
          )}
        </div>

        {bags.length > 0 && (
          <motion.div variants={fadeSlideUp} className="mt-6">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
              <PackageOpen size={13} className="text-relay-500" /> Goodie bags available here
            </p>
            <div className="flex flex-col gap-2">
              {bags.map((row) => {
                const hex = bytesToHex(row.hash);
                const claimed = claimedBagHexes.has(hex);
                const open = claimingBagHex === hex;
                return (
                  <div key={hex} className="rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
                    <div className="flex items-center gap-3">
                      {row.bag.photo_data_uri ? (
                        <img src={row.bag.photo_data_uri} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" />
                      ) : (
                        <div className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-amber-300 to-relay-500 text-xl">🎁</div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{row.bag.title}</p>
                        {row.bag.description && <p className="truncate text-xs text-ink-400">{row.bag.description}</p>}
                        <div className="flex items-center gap-2">
                          <StatNumber className="text-sm">{formatCents(row.bag.price_cents)}</StatNumber>
                          <span className="text-xs text-ink-400 line-through">{formatCents(row.bag.original_value_cents)}</span>
                        </div>
                      </div>
                      <Button
                        variant={claimed ? "secondary" : "primary"}
                        disabled={claimed}
                        className="shrink-0 px-3 py-1.5 text-xs"
                        onClick={() => openClaim(row)}
                      >
                        {claimed ? "Claimed" : open ? "Cancel" : "Claim"}
                      </Button>
                    </div>

                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                          <div className="mt-3 flex flex-col gap-2 border-t border-ink-100 dark:border-ink-800 pt-3">
                            {row.bag.supports_pickup && row.bag.supports_delivery && (
                              <div className="flex gap-2">
                                {(["Pickup", "Delivery"] as const).map((f) => (
                                  <button
                                    key={f}
                                    onClick={() => setClaimFulfillment(f)}
                                    className={`flex-1 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                                      claimFulfillment === f ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-500"
                                    }`}
                                  >
                                    {f}
                                  </button>
                                ))}
                              </div>
                            )}
                            {claimFulfillment === "Delivery" && (
                              <>
                                <AddressSearch value={claimDropoff} onChange={setClaimDropoff} label="Delivery location" />
                                <Input type="number" min={0} step={0.5} value={claimFee} onChange={(e) => setClaimFee(Number(e.target.value))} placeholder="Max delivery fee" prefix={currencySymbol()} />
                              </>
                            )}
                            {claimError && <p className="text-xs text-red-500">{claimError}</p>}
                            <Button loading={submittingClaim} onClick={() => submitClaim(row)} className="py-2 text-xs">
                              Confirm claim
                            </Button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}

        {dietaryTags.length > 0 && (
          <div className="mt-6 flex items-center gap-2">
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-300 dark:text-ink-600">Diet</span>
            <ChipRow>
              {dietaryTags.map((tag) => (
                <Chip key={tag} active={dietaryFilter.includes(tag)} onClick={() => setDietaryFilter((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))} tone="brand">
                  {tag}
                </Chip>
              ))}
            </ChipRow>
          </div>
        )}

        {[...grouped.entries()].map(([category, rows]) => (
          <motion.div variants={fadeSlideUp} key={category} className="mt-6">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">{category}</p>
            <div className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900">
              {rows.map(({ hash: itemHash, item }) => (
                <div key={bytesToHex(itemHash)} className="flex items-center gap-3 p-4">
                  {item.photo_data_uri && <img src={item.photo_data_uri} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{item.name}</p>
                    {item.description && <p className="truncate text-xs text-ink-400">{item.description}</p>}
                    <div className="flex items-center gap-2">
                      <StatNumber className="text-sm">{formatCents(item.price_cents)}</StatNumber>
                      {(() => {
                        const r = itemRatings[bytesToHex(itemHash)];
                        if (!r || r.count === 0) return null;
                        return (
                          <span className="flex items-center gap-0.5 text-xs text-ink-400">
                            <Star size={11} className="fill-amber-400 text-amber-400" /> {(r.rating_sum / r.count).toFixed(1)} ({r.count})
                          </span>
                        );
                      })()}
                    </div>
                    {(item.dietary_tags ?? []).length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(item.dietary_tags ?? []).map((tag) => (
                          <span key={tag} className="rounded-full bg-ink-100 dark:bg-ink-800 px-2 py-0.5 text-[10px] font-medium text-ink-500">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    {!item.available && <span className="text-xs font-medium text-red-600">Currently unavailable</span>}
                  </div>
                  <motion.button
                    whileTap={{ scale: 0.85 }}
                    disabled={!item.available || !status?.open}
                    aria-label={`Add ${item.name}`}
                    onClick={() => cart.addItem(catalogHash, catalog.owner, catalog.business_name, itemHash, item.name, item.price_cents)}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink-900 dark:bg-white text-white dark:text-ink-900 transition hover:scale-105 disabled:bg-ink-200 disabled:text-ink-400"
                  >
                    <Plus size={18} />
                  </motion.button>
                </div>
              ))}
            </div>
          </motion.div>
        ))}

        {items.length === 0 && <p className="mt-6 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 text-center text-sm text-ink-400">This merchant hasn't published any menu items yet.</p>}

        {reviews.length > 0 && (
          <motion.div variants={fadeSlideUp} className="mt-6">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
              <Star size={13} /> Reviews
            </p>
            <div className="flex flex-col gap-3 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
              {reviews.map((r, i) => (
                <div key={i} className="border-b border-ink-100 dark:border-ink-800 pb-3 last:border-0 last:pb-0">
                  <div className="flex items-center justify-between">
                    <StarRating value={r.rating} size={12} />
                    <span className="text-[11px] text-ink-300">{new Date(r.created_at / 1000).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                  </div>
                  {r.comment && <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{r.comment}</p>}
                </div>
              ))}
              {reviewsBefore !== null && (
                <Button variant="ghost" loading={loadingMoreReviews} onClick={loadMoreReviews} className="w-full py-2 text-xs">
                  Show older reviews
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </motion.div>

      <AnimatePresence>
        {cartCount > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 30 }}
            className="fixed inset-x-0 bottom-20 z-20 mx-auto flex max-w-md justify-center px-4"
          >
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={() => navigate("/customer/cart")}
              className="flex w-full items-center justify-between rounded-full bg-relay-500 px-5 py-3.5 font-semibold text-white shadow-[var(--shadow-glow)]"
            >
              <span className="flex items-center gap-2">
                <ShoppingBag size={18} />
                View cart · {cartCount} item{cartCount === 1 ? "" : "s"}
              </span>
              <span>{formatCents(cart.total())}</span>
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
