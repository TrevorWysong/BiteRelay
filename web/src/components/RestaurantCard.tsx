import { Link } from "react-router-dom";
import { Clock, Heart } from "lucide-react";
import { motion } from "framer-motion";
import type { GeoPoint, MerchantCatalog } from "../holochain/types";
import { deliveryEstimate } from "../lib/eta";
import { formatDistance } from "../lib/format";
import { bytesToHex } from "../holochain/decode";
import { Badge } from "./ui";
import { StarRating } from "./StarRating";
import { fadeSlideUp } from "../lib/motion";
import clsx from "clsx";
import { storeStatus } from "../lib/storeHours";

// Purely-cosmetic fallback for a merchant with no banner photo set yet --
// deterministic per catalog action hash so the same restaurant always
// looks the same without needing a real photo uploaded.
const GRADIENTS = [
  "from-orange-400 to-rose-500",
  "from-amber-400 to-orange-500",
  "from-lime-400 to-emerald-500",
  "from-sky-400 to-indigo-500",
  "from-fuchsia-400 to-purple-500",
  "from-teal-400 to-cyan-500",
];
const EMOJI = ["🍔", "🍕", "🍜", "🌮", "🍣", "🥗", "🍱", "🥪", "🍩", "🍛"];

function pick<T>(arr: T[], seed: Uint8Array): T {
  const n = seed.reduce((a, b) => a + b, 0);
  return arr[n % arr.length];
}

interface Props {
  catalogHash: Uint8Array;
  catalog: MerchantCatalog;
  /// What "open now" is judged against -- the list's clock.
  now: Date;
  rating?: number;
  reviewCount?: number;
  /// Where the customer is: the card shows how long delivery takes, and how
  /// far the store is.
  customer?: GeoPoint;
  /// Both omitted means "no favorite affordance at all" -- `Browse` is the
  /// only caller that currently passes these, since it's the only place
  /// that already holds the full favorited-set fetched once up front.
  favorited?: boolean;
  onToggleFavorite?: () => void;
}

export function RestaurantCard({ catalogHash, catalog, now, rating, reviewCount, customer, favorited, onToggleFavorite }: Props) {
  const status = storeStatus(catalog, now);
  const estimate = customer ? deliveryEstimate(catalog, customer) : null;
  const gradient = pick(GRADIENTS, catalogHash);
  const emoji = pick(EMOJI, catalogHash.slice().reverse());
  const hex = bytesToHex(catalogHash);

  return (
    // `catalog` has no single-fetch extern on the backend (only the
    // nearby-list one) -- passed via router state so the detail screen
    // doesn't need a redundant round trip for data it already has, with a
    // list re-fetch as its own fallback for a direct URL/refresh.
    <motion.div variants={fadeSlideUp} whileHover={{ y: -3 }} transition={{ duration: 0.18 }} className="group">
      <Link to={`/customer/merchant/${hex}`} state={{ catalog, catalogHash }} className="block overflow-hidden rounded-2xl shadow-[var(--shadow-card)]">
        <div className="relative h-32 overflow-hidden rounded-t-2xl">
          {catalog.banner_data_uri ? (
            <img
              src={catalog.banner_data_uri}
              alt=""
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            />
          ) : (
            <div className={`flex h-full items-center justify-center bg-gradient-to-br ${gradient} text-5xl transition duration-300 group-hover:scale-105`}>
              {emoji}
            </div>
          )}
          {!status.open && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <Badge tone="neutral">Closed</Badge>
            </div>
          )}
          {onToggleFavorite && (
            <motion.button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleFavorite();
              }}
              whileTap={{ scale: 0.85 }}
              className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/40 text-white backdrop-blur-sm transition hover:bg-black/60"
            >
              <Heart size={14} fill={favorited ? "currentColor" : "none"} className={favorited ? "text-red-400" : undefined} />
            </motion.button>
          )}
        </div>
        <div className="rounded-b-2xl border border-t-0 border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-3">
          <p className="truncate font-bold text-sm">{catalog.business_name}</p>
          <div className="mt-1 flex items-center gap-3 text-xs text-ink-400">
            {rating !== undefined && reviewCount ? (
              <StarRating value={rating} count={reviewCount} size={11} />
            ) : (
              <span>{catalog.cuisine_type || "New"}</span>
            )}
          </div>
          <p className={clsx("mt-1 flex min-w-0 items-center gap-1 truncate text-xs", status.open ? "text-presence-600" : "text-ink-400")}>
            <Clock size={11} className="shrink-0" />
            <span className="truncate">
              {status.open && estimate ? `${estimate.fromMinutes}–${estimate.toMinutes} min` : status.label}
              {estimate && <span className="text-ink-400"> · {formatDistance(estimate.km)}</span>}
            </span>
          </p>
        </div>
      </Link>
    </motion.div>
  );
}
