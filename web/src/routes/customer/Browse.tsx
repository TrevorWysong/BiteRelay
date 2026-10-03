import { useCallback, useEffect, useMemo, useState } from "react";
import { Heart, Search } from "lucide-react";
import { motion } from "framer-motion";
import clsx from "clsx";
import { getNearbyMerchants } from "../../holochain/zomes/catalog";
import { getReviewsFor } from "../../holochain/zomes/reputation";
import { addFavorite, removeFavorite, listFavorites } from "../../holochain/zomes/profiles";
import { decodeEntry, actionHash, bytesToHex } from "../../holochain/decode";
import { encodeGeohash } from "../../lib/geohash";
import { useSession } from "../../store/session";
import type { MerchantCatalog, Review } from "../../holochain/types";
import { RestaurantCard } from "../../components/RestaurantCard";
import { EmptyState, Skeleton } from "../../components/ui";
import { staggerContainer } from "../../lib/motion";

interface Row {
  hash: Uint8Array;
  catalog: MerchantCatalog;
  rating: number;
  reviewCount: number;
}

type Sort = "relevance" | "rating" | "name";

function ChipRow({ children }: { children: React.ReactNode }) {
  return <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto pb-0.5">{children}</div>;
}

function Chip({ active, onClick, children, tone = "default" }: { active: boolean; onClick: () => void; children: React.ReactNode; tone?: "default" | "danger" | "brand" }) {
  const activeClasses = tone === "danger" ? "bg-red-500 text-white" : tone === "brand" ? "bg-presence-500 text-white" : "bg-ink-900 text-white dark:bg-white dark:text-ink-900";
  return (
    <button
      onClick={onClick}
      className={clsx(
        "shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition",
        active ? activeClasses : "bg-ink-100 dark:bg-ink-800 text-ink-500 hover:bg-ink-200 dark:hover:bg-ink-700"
      )}
    >
      {children}
    </button>
  );
}

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
  const location = useSession((s) => s.location);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [query, setQuery] = useState("");
  const [cuisine, setCuisine] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("relevance");
  const [favoritesHex, setFavoritesHex] = useState<Set<string>>(new Set());
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [dietaryFilter, setDietaryFilter] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const geohash = encodeGeohash(location.lat, location.lon);
      const page = await getNearbyMerchants(geohash);
      if (cancelled) return;
      const withRatings = await Promise.all(
        page.catalogs.map(async (record) => {
          const catalog = decodeEntry<MerchantCatalog>(record);
          const reviews = await getReviewsFor(catalog.owner).then((rs) => rs.map((r) => decodeEntry<Review>(r)));
          const rating = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
          return { hash: actionHash(record), catalog, rating, reviewCount: reviews.length };
        }),
      );
      if (!cancelled) setRows(withRatings);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [location]);

  // Independent of `location` -- a personal saved-restaurant list, not
  // scoped to "what's nearby right now."
  useEffect(() => {
    listFavorites()
      .then((hashes) => setFavoritesHex(new Set(hashes.map(bytesToHex))))
      .catch(() => {});
  }, []);

  const toggleFavorite = useCallback(async (hash: Uint8Array) => {
    const hex = bytesToHex(hash);
    const wasFavorited = favoritesHex.has(hex);
    // Optimistic -- a favorite toggle should feel instant, and reverting on
    // the rare failure is cheap (just flips the Set back).
    setFavoritesHex((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(hex);
      else next.add(hex);
      return next;
    });
    try {
      if (wasFavorited) await removeFavorite(hash);
      else await addFavorite(hash);
    } catch {
      setFavoritesHex((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(hex);
        else next.delete(hex);
        return next;
      });
    }
  }, [favoritesHex]);

  const cuisines = useMemo(() => {
    const set = new Set<string>();
    rows?.forEach((r) => r.catalog.cuisine_type && set.add(r.catalog.cuisine_type));
    return [...set].sort();
  }, [rows]);

  const dietaryTags = useMemo(() => {
    const set = new Set<string>();
    rows?.forEach((r) => (r.catalog.dietary_tags ?? []).forEach((t) => set.add(t)));
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    let list = rows?.filter((r) => r.catalog.business_name.toLowerCase().includes(query.toLowerCase())) ?? null;
    if (list && cuisine) list = list.filter((r) => r.catalog.cuisine_type === cuisine);
    if (list && favoritesOnly) list = list.filter((r) => favoritesHex.has(bytesToHex(r.hash)));
    // OR semantics -- "has at least one of the selected tags," the more
    // forgiving reading for a browse filter (a restaurant with *some*
    // vegetarian options is still worth showing to a vegetarian customer,
    // even if its whole menu isn't vegetarian).
    if (list && dietaryFilter.length > 0) list = list.filter((r) => dietaryFilter.some((tag) => (r.catalog.dietary_tags ?? []).includes(tag)));
    if (list) {
      list = [...list].sort((a, b) => {
        if (sort === "rating") return b.rating - a.rating;
        if (sort === "name") return a.catalog.business_name.localeCompare(b.catalog.business_name);
        return 0;
      });
    }
    return list;
  }, [rows, query, cuisine, sort, favoritesOnly, favoritesHex, dietaryFilter]);

  return (
    <div className="px-4 pt-4">
      <div className="mb-4 flex items-center gap-2 rounded-full border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900 px-4 py-2.5 transition focus-within:border-relay-400 focus-within:ring-2 focus-within:ring-relay-100">
        <Search size={16} className="text-ink-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search restaurants"
          className="w-full bg-transparent text-sm outline-none"
        />
      </div>

      <h1 className="mb-1 text-xl font-black tracking-tight">Restaurants near you</h1>
      <p className="mb-4 text-xs text-ink-400">
        {rows?.length ?? "…"} restaurant{rows?.length === 1 ? "" : "s"} open near you right now.
      </p>

      {cuisines.length > 0 && (
        <ChipRow>
          <Chip active={cuisine === null} onClick={() => setCuisine(null)}>
            All
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
            <Heart size={12} fill={favoritesOnly ? "currentColor" : "none"} /> Favorites
          </span>
        </Chip>
        <div className="ml-auto flex items-center gap-1 rounded-full bg-ink-100 dark:bg-ink-800 p-1 text-xs font-semibold">
          {(["relevance", "rating", "name"] as Sort[]).map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={clsx(
                "rounded-full px-2.5 py-1 capitalize transition",
                sort === s ? "bg-white dark:bg-ink-950 shadow-sm text-ink-900 dark:text-white" : "text-ink-400"
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {dietaryTags.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
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

      {rows === null && (
        <div className="grid grid-cols-2 gap-3 pb-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      )}

      {rows !== null && filtered?.length === 0 && (
        <EmptyState title="No restaurants nearby yet" subtitle="Switch to Sell mode to add one and see how it looks here." />
      )}

      {filtered && filtered.length > 0 && (
        <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="grid grid-cols-2 gap-3 pb-6">
          {filtered.map((r) => (
            <RestaurantCard
              key={bytesToHex(r.hash)}
              catalogHash={r.hash}
              catalog={r.catalog}
              rating={r.rating}
              reviewCount={r.reviewCount}
              favorited={favoritesHex.has(bytesToHex(r.hash))}
              onToggleFavorite={() => toggleFavorite(r.hash)}
            />
          ))}
        </motion.div>
      )}
    </div>
  );
}
