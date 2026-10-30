// A newest-first list of reviews -- a store's, or a menu item's -- with
// older ones loaded on request. Renders nothing until there's one to show.
import { useState } from "react";
import { Star } from "lucide-react";
import type { ReviewsPage } from "../holochain/zomes/reputation";
import type { Timestamp } from "../holochain/types";
import { actionHash, bytesToHex, decodeEntry } from "../holochain/decode";
import { useResource } from "../lib/hooks/useResource";
import { formatDate } from "../lib/ui/format";
import { Button } from "./ui";
import { StarRating } from "./StarRating";
import { useT } from "../i18n";

/// What every kind of review has.
interface Reviewed {
  rating: number;
  comment: string;
  created_at: Timestamp;
}

interface Feed {
  reviews: { key: string; review: Reviewed }[];
  before: Timestamp | null;
}

function toFeed(page: ReviewsPage): Feed {
  return { reviews: page.reviews.map((record) => ({ key: bytesToHex(actionHash(record)), review: decodeEntry<Reviewed>(record) })), before: page.next_before };
}

/// `feedKey` names what's reviewed (a new one starts over); `fetchPage`
/// reads the reviews before a time, `null` for the newest.
export function ReviewList({ feedKey, fetchPage, className }: { feedKey: string; fetchPage: (before: Timestamp | null) => Promise<ReviewsPage>; className?: string }) {
  const t = useT();
  const [loadingMore, setLoadingMore] = useState(false);
  const { data, mutate } = useResource<Feed>(`reviews:${feedKey}`, () => fetchPage(null).then(toFeed));

  async function loadMore() {
    if (!data?.before) return;
    setLoadingMore(true);
    try {
      const next = toFeed(await fetchPage(data.before));
      mutate((prev) => ({ reviews: [...(prev?.reviews ?? []), ...next.reviews], before: next.before }));
    } finally {
      setLoadingMore(false);
    }
  }

  if (!data?.reviews.length) return null;
  return (
    <div className={className}>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
        <Star size={13} /> {t("store.reviews")}
      </p>
      <div className="flex flex-col gap-3 rounded-2xl border border-ink-100 bg-white p-4 dark:border-ink-800 dark:bg-ink-900">
        {data.reviews.map(({ key, review }) => (
          <div key={key} className="border-b border-ink-100 pb-3 last:border-0 last:pb-0 dark:border-ink-800">
            <div className="flex items-center justify-between">
              <StarRating value={review.rating} size={12} />
              <span className="text-[11px] text-ink-300">{formatDate(review.created_at)}</span>
            </div>
            {review.comment && <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{review.comment}</p>}
          </div>
        ))}
        {data.before !== null && (
          <Button variant="ghost" loading={loadingMore} onClick={loadMore} className="w-full py-2 text-xs">
            {t("store.olderReviews")}
          </Button>
        )}
      </div>
    </div>
  );
}
