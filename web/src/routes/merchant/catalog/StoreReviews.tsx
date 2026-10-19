import { useState } from "react";
import { Star } from "lucide-react";
import { getReviewsFor } from "../../../holochain/zomes/reputation";
import { bytesToHex, decodeEntry } from "../../../holochain/decode";
import { useResource } from "../../../lib/useResource";
import { Button, Card } from "../../../components/ui";
import { StarRating } from "../../../components/StarRating";
import type { Review, Timestamp } from "../../../holochain/types";
import { useT } from "../../../i18n";

interface ReviewFeed {
  reviews: Review[];
  before: Timestamp | null;
}

/// This store's own reviews, newest first -- never the owner's other
/// stores, and never their driving (see `reputation_integrity`).
export function StoreReviews({ storeHex, catalogRef }: { storeHex: string; catalogRef: Uint8Array }) {
  const [loadingMore, setLoadingMore] = useState(false);
  const t = useT();
  const { data, mutate } = useResource<ReviewFeed>(`store-reviews:${storeHex}`, async () => {
    const page = await getReviewsFor({ Store: catalogRef });
    return { reviews: page.reviews.map((r) => decodeEntry<Review>(r)), before: page.next_before };
  });

  async function loadMore() {
    if (!data?.before) return;
    setLoadingMore(true);
    try {
      const page = await getReviewsFor({ Store: catalogRef }, data.before);
      mutate((prev) => ({ reviews: [...(prev?.reviews ?? []), ...page.reviews.map((r) => decodeEntry<Review>(r))], before: page.next_before }));
    } finally {
      setLoadingMore(false);
    }
  }

  if (!data?.reviews.length) return null;
  return (
    <Card className="p-4">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
        <Star size={13} /> {t("store.reviews")}
      </p>
      <div className="flex flex-col gap-3">
        {/* One store review per order, so the order identifies it. */}
        {data.reviews.map((review) => (
          <div key={bytesToHex(review.order_ref)} className="border-b border-ink-100 dark:border-ink-800 pb-2 last:border-0 last:pb-0">
            <div className="flex items-center justify-between">
              <StarRating value={review.rating} size={12} />
              <span className="text-[11px] text-ink-300">{new Date(review.created_at / 1000).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
            </div>
            {review.comment && <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{review.comment}</p>}
          </div>
        ))}
      </div>
      {data.before !== null && (
        <Button variant="ghost" loading={loadingMore} onClick={loadMore} className="mt-3 w-full py-2 text-xs">
          {t("store.olderReviews")}
        </Button>
      )}
    </Card>
  );
}
