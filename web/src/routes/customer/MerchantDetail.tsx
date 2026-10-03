import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Clock, Heart, MapPin, Phone, Plus, ShoppingBag, Star } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { getNearbyMerchants, listMenuItems } from "../../holochain/zomes/catalog";
import { getReviewsFor, getItemRatingSummary, type ItemRatingSummary } from "../../holochain/zomes/reputation";
import { addFavorite, removeFavorite, listFavorites } from "../../holochain/zomes/profiles";
import { decodeEntry, actionHash, hexToBytes, bytesToHex } from "../../holochain/decode";
import { encodeGeohash } from "../../lib/geohash";
import { useSession } from "../../store/session";
import { useCart } from "../../store/cart";
import { formatCents } from "../../lib/format";
import { Skeleton, StatNumber } from "../../components/ui";
import { StarRating } from "../../components/StarRating";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import type { MenuItem, MerchantCatalog, Review } from "../../holochain/types";

interface ItemRow {
  hash: Uint8Array;
  item: MenuItem;
}

export function MerchantDetail() {
  const { hash } = useParams<{ hash: string }>();
  const navigate = useNavigate();
  const routerState = useLocation().state as { catalog?: MerchantCatalog; catalogHash?: Uint8Array } | null;
  const location = useSession((s) => s.location);
  const cart = useCart();
  const [catalog, setCatalog] = useState<MerchantCatalog | null>(routerState?.catalog ?? null);
  const [catalogHash, setCatalogHash] = useState<Uint8Array | null>(routerState?.catalogHash ?? null);
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [favorited, setFavorited] = useState(false);
  const [itemRatings, setItemRatings] = useState<Record<string, ItemRatingSummary>>({});

  useEffect(() => {
    if (!hash) return;
    const wanted = hexToBytes(hash);
    setCatalogHash(wanted);
    setItems(null);

    if (!routerState?.catalog) {
      // No direct "get catalog by ref" extern is exposed today -- reuse the
      // nearby-merchants anchor read and find this one when arriving via a
      // direct URL/refresh rather than a card click.
      getNearbyMerchants(encodeGeohash(location.lat, location.lon)).then((page) => {
        const match = page.catalogs.find((r) => bytesToHex(actionHash(r)) === hash);
        if (match) setCatalog(decodeEntry<MerchantCatalog>(match));
      });
    }
    listMenuItems(wanted).then((page) => {
      const rows = page.items.map((r) => ({ hash: actionHash(r), item: decodeEntry<MenuItem>(r) }));
      setItems(rows);
      // Bounded by the page itself (a merchant's own menu, already capped --
      // see list_menu_items' own pagination), same cost category as the
      // per-restaurant review fetch Browse.tsx already does.
      rows.forEach((row) => {
        const hex = bytesToHex(row.hash);
        getItemRatingSummary(row.hash)
          .then((summary) => setItemRatings((prev) => ({ ...prev, [hex]: summary })))
          .catch(() => {});
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, location]);

  useEffect(() => {
    if (!catalog) return;
    getReviewsFor(catalog.owner).then((records) => setReviews(records.map((r) => decodeEntry<Review>(r))));
  }, [catalog]);

  useEffect(() => {
    if (!catalogHash) return;
    const hex = bytesToHex(catalogHash);
    listFavorites()
      .then((hashes) => setFavorited(hashes.some((h) => bytesToHex(h) === hex)))
      .catch(() => {});
  }, [catalogHash]);

  async function toggleFavorite() {
    if (!catalogHash) return;
    const next = !favorited;
    setFavorited(next); // optimistic, same reasoning as Browse.tsx's toggle
    try {
      if (next) await addFavorite(catalogHash);
      else await removeFavorite(catalogHash);
    } catch {
      setFavorited(!next);
    }
  }

  if (!catalog || !items || !catalogHash) {
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
  const avgRating = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
  const grouped = new Map<string, ItemRow[]>();
  for (const row of items) {
    const key = row.item.category || "Menu";
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

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
        <motion.button whileTap={{ scale: 0.85 }} onClick={toggleFavorite} className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-white/90 shadow backdrop-blur-sm">
          <Heart size={18} className="text-red-500" fill={favorited ? "currentColor" : "none"} />
        </motion.button>
      </div>

      <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4">
        <motion.h1 variants={fadeSlideUp} className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">{catalog.business_name}</motion.h1>
        {catalog.description && <p className="mt-1 text-sm text-ink-500">{catalog.description}</p>}

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-400">
          {reviews.length > 0 && <StarRating value={avgRating} count={reviews.length} />}
          <span className={catalog.is_open ? "font-semibold text-presence-600" : "font-semibold text-red-500"}>{catalog.is_open ? "Open now" : "Closed"}</span>
          {catalog.cuisine_type && <span>{catalog.cuisine_type}</span>}
          {(catalog.hours_open || catalog.hours_close) && (
            <span className="flex items-center gap-1">
              <Clock size={12} />
              {catalog.hours_open || "?"}–{catalog.hours_close || "?"}
            </span>
          )}
          {catalog.address_line && (
            <span className="flex items-center gap-1">
              <MapPin size={12} /> {catalog.address_line}
            </span>
          )}
          {catalog.phone && (
            <span className="flex items-center gap-1">
              <Phone size={12} /> {catalog.phone}
            </span>
          )}
        </div>

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
                    {item.dietary_tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {item.dietary_tags.map((tag) => (
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
                    disabled={!item.available || !catalog.is_open}
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
                  <StarRating value={r.rating} size={12} />
                  {r.comment && <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{r.comment}</p>}
                </div>
              ))}
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
