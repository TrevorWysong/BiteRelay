import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Heart, PackageOpen, Search } from "lucide-react";
import { motion } from "framer-motion";
import clsx from "clsx";
import { getNearbyMerchants, getNearbyGoodieBags } from "../../holochain/zomes/catalog";
import { averageRating, getRatingSummary } from "../../holochain/zomes/reputation";
import { decodeEntry, bytesToHex } from "../../holochain/decode";
import { encodeGeohash } from "../../lib/geohash";
import { useSession } from "../../store/session";
import { useFavorites } from "../../lib/useFavorites";
import { useResource } from "../../lib/useResource";
import { formatCents } from "../../lib/format";
import type { MerchantCatalog, GoodieBag } from "../../holochain/types";
import { RestaurantCard } from "../../components/RestaurantCard";
import { AddressSwitcher } from "../../components/AddressSwitcher";
import { Chip, ChipRow, EmptyState, Skeleton } from "../../components/ui";
import { staggerContainer } from "../../lib/motion";
import { POLL } from "../../lib/poll";
import { useClock } from "../../lib/useClock";
import { storeStatus } from "../../lib/storeHours";
import { useT } from "../../i18n";

interface Row {
  hash: Uint8Array;
  catalog: MerchantCatalog;
  rating: number;
  reviewCount: number;
}

interface BagRow {
  hash: Uint8Array;
  bag: GoodieBag;
}

type Sort = "relevance" | "rating" | "name";

// A restaurant that just published can take a while to become discoverable
// -- its GeohashToCatalog link has to reach whatever peer answers this
// read, not just the merchant's own chain (the project's own,
// long-documented DHT-propagation characteristic, roughly
// seconds-to-a-minute scale here, not instant). Without a poll, a customer
// already sitting on Browse when a merchant nearby publishes would see an
// empty list forever unless they happened to navigate away and back.
// Polled slowly (`POLL.slow`): stores open and close rarely.

function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-ink-100/60 dark:border-ink-800">
      <Skeleton className="h-32 w-full rounded-none" />
      <div className="space-y-2 bg-white p-3 dark:bg-ink-900">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

export function Browse() {
  const now = useClock();
  const t = useT();
  const navigate = useNavigate();
  const location = useSession((s) => s.location);
  const [query, setQuery] = useState("");
  const [cuisine, setCuisine] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("relevance");
  const { favoritesHex, toggleFavorite } = useFavorites();
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  // Keyed by the browsing cell -- changing address drops any in-flight
  // reply for the old one instead of letting it overwrite the new list.
  const geohash = encodeGeohash(location.lat, location.lon);
  const { data: rows } = useResource<Row[]>(
    `browse-stores:${geohash}`,
    async () => {
      const page = await getNearbyMerchants(geohash);
      // Use `view.original_action`, never `actionHash(view.record)` -- the
      // record is resolved to this catalog's *latest* state, so its own
      // action hash drifts on every edit. See `CatalogView`'s own doc
      // comment. One bounded, checkpointed summary read per card -- this
      // store's own rating only, never the owner's other stores or their
      // driving (see `reputation_integrity`'s module doc).
      return Promise.all(
        page.catalogs.map(async (view) => {
          const catalog = decodeEntry<MerchantCatalog>(view.record);
          const summary = await getRatingSummary({ Store: view.original_action }).catch(() => ({ count: 0, rating_sum: 0 }));
          return { hash: view.original_action, catalog, rating: averageRating(summary) ?? 0, reviewCount: summary.count };
        }),
      );
    },
    { pollMs: POLL.slow },
  );
  // Expired bags are already filtered out server-side (and claims after the
  // window are rejected on-chain); filtering again here drops one that
  // closed since the last poll. `original_action` is the bag's identity --
  // what a claim references.
  const { data: bags = [] } = useResource<BagRow[]>(
    `browse-bags:${geohash}`,
    async () => {
      const views = await getNearbyGoodieBags(geohash);
      const now = Date.now() * 1000;
      return views.map((v) => ({ hash: v.original_action, bag: decodeEntry<GoodieBag>(v.record) })).filter((r) => r.bag.pickup_window_end > now);
    },
    { pollMs: POLL.slow },
  );

  const catalogNameByHex = useMemo(() => {
    const map = new Map<string, string>();
    rows?.forEach((r) => map.set(bytesToHex(r.hash), r.catalog.business_name));
    return map;
  }, [rows]);

  const cuisines = useMemo(() => {
    const set = new Set<string>();
    rows?.forEach((r) => r.catalog.cuisine_type && set.add(r.catalog.cuisine_type));
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    // Name, cuisine, description and dietary tags, as people search: "tacos",
    // "vegan", "pizza".
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = (c: MerchantCatalog) => [c.business_name, c.cuisine_type, c.description, ...(c.dietary_tags ?? [])].join(" ").toLowerCase();
    let list = rows?.filter((r) => words.every((word) => haystack(r.catalog).includes(word))) ?? null;
    if (list && cuisine) list = list.filter((r) => r.catalog.cuisine_type === cuisine);
    if (list && favoritesOnly) list = list.filter((r) => favoritesHex.has(bytesToHex(r.hash)));
    if (list) {
      // Open stores first, the way the list reads; then the chosen order.
      const open = (r: Row) => (storeStatus(r.catalog, now).open ? 0 : 1);
      list = [...list].sort((a, b) => {
        if (open(a) !== open(b)) return open(a) - open(b);
        if (sort === "rating") return b.rating - a.rating;
        if (sort === "name") return a.catalog.business_name.localeCompare(b.catalog.business_name);
        return 0;
      });
    }
    return list;
  }, [rows, query, cuisine, sort, favoritesOnly, favoritesHex, now]);

  return (
    <div className="px-4 pt-4">
      <AddressSwitcher />

      <div className="mb-4 flex items-center gap-2 rounded-full border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900 px-4 py-2.5 transition focus-within:border-relay-400 focus-within:ring-2 focus-within:ring-relay-100">
        <Search size={16} className="text-ink-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("browse.search")}
          className="w-full bg-transparent text-sm outline-none"
        />
      </div>

      {bags.length > 0 && (
        <div className="mb-5">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
            <PackageOpen size={13} className="text-relay-500" /> {t("browse.bagsNearMe")}
          </p>
          <div className="no-scrollbar flex gap-3 overflow-x-auto pb-1">
            {bags.map((row) => (
              <button
                key={bytesToHex(row.hash)}
                onClick={() => navigate(`/customer/merchant/${bytesToHex(row.bag.catalog_ref)}`)}
                className="w-40 shrink-0 overflow-hidden rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 text-left"
              >
                {row.bag.photo_data_uri ? (
                  <img src={row.bag.photo_data_uri} alt="" className="h-20 w-full object-cover" />
                ) : (
                  <div className="flex h-20 w-full items-center justify-center bg-gradient-to-br from-amber-300 to-relay-500 text-2xl">🎁</div>
                )}
                <div className="p-2.5">
                  <p className="truncate text-xs font-semibold text-ink-900 dark:text-ink-50">{row.bag.title}</p>
                  <p className="truncate text-[11px] text-ink-400">{catalogNameByHex.get(bytesToHex(row.bag.catalog_ref)) ?? t("browse.nearbyRestaurant")}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="text-sm font-black text-relay-600 dark:text-relay-400">{formatCents(row.bag.price_cents)}</span>
                    <span className="text-[11px] text-ink-400 line-through">{formatCents(row.bag.original_value_cents)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <h1 className="mb-1 text-xl font-black tracking-tight">{t("browse.title")}</h1>
      <p className="mb-4 text-xs text-ink-400">
        {rows === undefined ? "…" : t("browse.openCount", { count: rows.length })}
      </p>

      {cuisines.length > 0 && (
        <ChipRow>
          <Chip active={cuisine === null} onClick={() => setCuisine(null)}>
            {t("browse.all")}
          </Chip>
          {cuisines.map((c) => (
            <Chip key={c} active={cuisine === c} onClick={() => setCuisine(c)}>
              {c}
            </Chip>
          ))}
        </ChipRow>
      )}

      <div className="mb-3 flex items-center gap-2">
        <Chip active={favoritesOnly} onClick={() => setFavoritesOnly((v) => !v)} tone="danger">
          <span className="flex items-center gap-1">
            <Heart size={12} fill={favoritesOnly ? "currentColor" : "none"} /> {t("browse.favorites")}
          </span>
        </Chip>
        <div className="ml-auto flex items-center gap-1 rounded-full bg-ink-100 dark:bg-ink-800 p-1 text-xs font-semibold">
          {(["relevance", "rating", "name"] as Sort[]).map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={clsx(
                "rounded-full px-2.5 py-1 transition",
                sort === s ? "bg-white dark:bg-ink-950 shadow-sm text-ink-900 dark:text-white" : "text-ink-400"
              )}
            >
              {t(`browse.sort.${s}`)}
            </button>
          ))}
        </div>
      </div>

      {rows === undefined && (
        <div className="grid grid-cols-2 gap-3 pb-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      )}

      {rows !== undefined && filtered?.length === 0 && (
        <EmptyState title={t("browse.emptyTitle")} subtitle={t("browse.emptySubtitle")} />
      )}

      {filtered && filtered.length > 0 && (
        <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="grid grid-cols-2 gap-3 pb-6">
          {filtered.map((r) => (
            <RestaurantCard
              key={bytesToHex(r.hash)}
              catalogHash={r.hash}
              catalog={r.catalog}
              now={now}
              rating={r.rating}
              reviewCount={r.reviewCount}
              customer={location}
              favorited={favoritesHex.has(bytesToHex(r.hash))}
              onToggleFavorite={() => toggleFavorite(r.hash)}
            />
          ))}
        </motion.div>
      )}
    </div>
  );
}
