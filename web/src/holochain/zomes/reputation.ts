import { callZome } from "../client";
import type { ActionHash, HcRecord, RatingSummary, ReputationSummary, ReputationTarget, ReviewTarget, Timestamp } from "../types";

/// A UI-display cache only -- see `reputation_integrity`'s doc comment.
/// Never the actual trust decision on its own; `check_warrants`
/// (dispatch.ts) is the real signal `accept_bid` gates on.
export async function getReputationSummary(target: ReputationTarget): Promise<ReputationSummary> {
  return callZome("reputation", "get_reputation_summary", target);
}

/// Refused if the caller already rated this target on this order -- one
/// rating per store/driver per order.
export async function submitReview(input: { target: ReviewTarget; order_original_action: ActionHash; rating: number; comment: string }): Promise<HcRecord> {
  return callZome("reputation", "submit_review", input);
}

export interface ReviewsPage {
  reviews: HcRecord[];
  next_before: Timestamp | null;
}

/// Newest first, paginated -- pass the previous page's `next_before` to load
/// older reviews. For the average, use `getRatingSummary` instead of
/// loading every review.
export async function getReviewsFor(target: ReviewTarget, before: Timestamp | null = null): Promise<ReviewsPage> {
  return callZome("reputation", "get_reviews_for", { target, before });
}

/// The star rating for a store or driver, as a running count + sum
/// (checkpointed on the Rust side, so it stays cheap as reviews pile up).
export async function getRatingSummary(target: ReviewTarget): Promise<RatingSummary> {
  return callZome("reputation", "get_rating_summary", target);
}

/// The caller's own store/driver reviews already left on this order -- an
/// order screen uses this to show "thanks for rating" instead of the form.
export async function getMyReviewsForOrder(orderOriginalAction: ActionHash): Promise<HcRecord[]> {
  return callZome("reputation", "get_my_reviews_for_order", orderOriginalAction);
}

/// `null` when there are no ratings yet.
export function averageRating(summary: RatingSummary): number | null {
  return summary.count > 0 ? summary.rating_sum / summary.count : null;
}

// --- per-item ratings -- same shape as the store/driver reviews above,
// keyed by a MenuItem's action hash instead ---

export async function submitItemReview(input: { item_ref: ActionHash; order_original_action: ActionHash; rating: number; comment: string }): Promise<HcRecord> {
  return callZome("reputation", "submit_item_review", input);
}

export interface ItemRatingSummary {
  count: number;
  rating_sum: number;
}

export async function getItemRatingSummary(itemRef: ActionHash): Promise<ItemRatingSummary> {
  return callZome("reputation", "get_item_rating_summary", itemRef);
}

/// A menu item's reviews, newest first -- pass the previous page's
/// `next_before` to continue.
export async function getItemReviews(itemRef: ActionHash, before: Timestamp | null = null): Promise<ReviewsPage> {
  return callZome("reputation", "get_item_reviews", { item_ref: itemRef, before });
}
