import { getReviewsFor } from "../../../holochain/zomes/reputation";
import { ReviewList } from "../../../components/ReviewList";

/// This store's own reviews, newest first -- never the owner's other
/// stores, and never their driving (see `reputation_integrity`).
export function StoreReviews({ storeHex, catalogRef }: { storeHex: string; catalogRef: Uint8Array }) {
  return <ReviewList feedKey={`store:${storeHex}`} fetchPage={(before) => getReviewsFor({ Store: catalogRef }, before)} />;
}
