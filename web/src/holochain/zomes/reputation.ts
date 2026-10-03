import { callZome } from "../client";
import type { ActionHash, AgentPubKey, HcRecord, ReputationSummary } from "../types";

/// A UI-display cache only -- see `reputation_integrity`'s doc comment.
/// Never the actual trust decision on its own; `check_warrants`
/// (dispatch.ts) is the real signal `accept_bid` gates on.
export async function getReputationSummary(agent: AgentPubKey): Promise<ReputationSummary> {
  return callZome("reputation", "get_reputation_summary", agent);
}

export async function submitReview(input: { subject: AgentPubKey; order_original_action: ActionHash; rating: number; comment: string }): Promise<HcRecord> {
  return callZome("reputation", "submit_review", input);
}

export async function getReviewsFor(subject: AgentPubKey): Promise<HcRecord[]> {
  return callZome("reputation", "get_reviews_for", subject);
}

// --- per-item ratings -- same shape as Review above, keyed by a MenuItem's
// action hash instead of an agent pubkey ---

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

export async function getItemReviews(itemRef: ActionHash): Promise<HcRecord[]> {
  return callZome("reputation", "get_item_reviews", itemRef);
}
