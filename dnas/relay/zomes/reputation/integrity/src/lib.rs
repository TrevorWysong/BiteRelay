//! Integrity zome for reputation: append-only `ReputationEvent`s -- see the
//! type's doc comment for why this is a cache, not the trust source of
//! truth, and why append-only rather than a mutable score.

use dispatch_types::{Bid, DeliveryOrder, DeliveryStatus, PickupOrder, PickupStatus};
use hdi::prelude::*;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum ReputationRole {
    Requester,
    Provider,
    Merchant,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum ReputationEventKind {
    OrderCompleted { subject_role: ReputationRole },
    OrderCancelledByThem,
    DisputeRaised,
    DisputeResolvedAgainst,
    CollateralForfeited { amount: u64 },
}

/// Append-only by design (see architecture plan §2): a single mutable
/// "score" entry would invite concurrent-update races when two orders
/// complete near-simultaneously. "Score" is always a derived read over these
/// events, never stored.
///
/// IMPORTANT, per the plan: treat this whole event log as a UI-display
/// cache, not the trust source of truth -- it's self-authored (by the
/// counterparty, see validation below) and so is a single-party claim in
/// isolation. A real accept-bid decision should check the counterparty's
/// actual `get_agent_activity` chain for genuine ReceiptAttestation entries
/// and any outstanding warrants, not just this log.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct ReputationEvent {
    pub subject: AgentPubKey,
    pub counterparty: AgentPubKey,
    pub order_ref: ActionHash,
    pub kind: ReputationEventKind,
    pub recorded_at: Timestamp,
}

/// A periodic, append-only "summary as of `related_event`" breadcrumb --
/// the exact same pattern, for the exact same reasons, as `ledger`'s
/// `BalanceCheckpoint` (architecture plan §9.4): `get_reputation_summary`
/// finds the most recent one instead of rescanning an agent's *entire*
/// event history on every read, written *roughly* every
/// `CHECKPOINT_INTERVAL` events (deterministic, counting-free trigger in
/// the coordinator), giving O(n/K) reads, not O(1) -- named honestly, not
/// oversold, same as `ledger`'s. Append-only for the same reason too: a
/// mutable shared summary entry would reintroduce the exact concurrent-
/// write race this whole event log was designed to avoid in the first
/// place (see `ReputationEvent`'s doc comment above).
#[hdk_entry_helper]
#[derive(Clone)]
pub struct ReputationCheckpoint {
    pub subject: AgentPubKey,
    pub completed_count: u32,
    pub cancelled_by_them_count: u32,
    pub dispute_raised_count: u32,
    pub dispute_resolved_against_count: u32,
    pub total_collateral_forfeited: u64,
    pub related_event: ActionHash,
    pub recorded_at: Timestamp,
}

/// A star rating + free-text comment against a real, completed order --
/// deliberately its own entry type rather than a `ReputationEventKind`
/// variant, since a review is customer-facing content (shown on a
/// merchant's storefront, a driver's profile), not an internal trust
/// signal like the existing event log. Same posture as that log, though:
/// self-authored by the reviewer, so it's a UI-display feature, not a
/// cryptographically-enforced fact -- nothing stops a rating from being
/// unfair, only from being fabricated by someone who wasn't a party to the
/// order at all (see `validate_review` below).
#[hdk_entry_helper]
#[derive(Clone)]
pub struct Review {
    pub subject: AgentPubKey,
    pub author: AgentPubKey,
    pub order_ref: ActionHash,
    pub rating: u8,
    pub comment: String,
    pub created_at: Timestamp,
}

/// A star rating + comment against a specific *menu item* (not an agent) --
/// same posture as `Review`: self-authored by the customer, a UI-display
/// feature rather than a cryptographically-enforced fact, except there's no
/// "subject" agent to worry about self-flattery from at all (you're rating
/// a product, not yourself). The one real check that makes this different
/// from just reusing `Review` with an `ActionHash` subject: `item_ref` must
/// actually have been part of the reviewed order (see `validate_item_review`)
/// -- otherwise a customer could rate an item they never ordered.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct ItemReview {
    pub item_ref: ActionHash,
    pub author: AgentPubKey,
    pub order_ref: ActionHash,
    pub rating: u8,
    pub comment: String,
    pub created_at: Timestamp,
}

/// Same O(n/K) checkpoint pattern as `ReputationCheckpoint`/`BalanceCheckpoint`
/// (architecture plan §9.4), carrying forward a running `(count, rating_sum)`
/// pair instead of a single number -- an average can't be folded
/// incrementally from just the prior average, it needs both the count and
/// the sum to stay exact.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct ItemRatingCheckpoint {
    pub item_ref: ActionHash,
    pub count: u32,
    pub rating_sum: u32,
    pub related_review: ActionHash,
    pub recorded_at: Timestamp,
}

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    ReputationEvent(ReputationEvent),
    ReputationCheckpoint(ReputationCheckpoint),
    Review(Review),
    ItemReview(ItemReview),
    ItemRatingCheckpoint(ItemRatingCheckpoint),
}

#[hdk_link_types]
pub enum LinkTypes {
    SubjectToEvent,
    SubjectToReputationCheckpoint,
    SubjectToReview,
    ItemToReview,
    ItemToRatingCheckpoint,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::ReputationEvent(event) => validate_event(&event, action.author()),
            EntryTypes::ReputationCheckpoint(checkpoint) => validate_checkpoint(&checkpoint, action.author()),
            EntryTypes::Review(review) => validate_review(&review, action.author()),
            EntryTypes::ItemReview(review) => validate_item_review(&review, action.author()),
            EntryTypes::ItemRatingCheckpoint(checkpoint) => validate_item_rating_checkpoint(&checkpoint, action.author()),
        },
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

/// What `validate_review`/`validate_item_review` both need from whichever
/// order type `order_ref` actually resolves to -- a `Review`/`ItemReview`
/// is generic over which vertical it's about (see `Dispute`'s own doc
/// comment in `dispute_integrity` for the identical reasoning), so this
/// resolves either `DeliveryOrder` or `PickupOrder` to the same shape
/// rather than duplicating both review functions once per order type.
struct ReviewableOrder {
    requester: AgentPubKey,
    item_refs: Vec<ActionHash>,
    /// Who a `Review.subject` is allowed to name -- the merchant, plus the
    /// accepted driver for a delivery (pickup has no driver at all).
    valid_subjects: Vec<AgentPubKey>,
}

/// `not_yet_delivered_msg`/`not_yet_picked_up_msg` let each caller keep its
/// own exact wording ("a review"/"an item") for the one error message that
/// differs between `validate_review` and `validate_item_review`, rather
/// than this shared helper flattening both into one generic string.
fn resolve_reviewable_order(
    order_ref: &ActionHash,
    not_yet_delivered_msg: &str,
    not_yet_picked_up_msg: &str,
) -> ExternResult<Result<ReviewableOrder, String>> {
    let order_record = must_get_valid_record(order_ref.clone())?;
    if let Ok(Some(order)) = order_record.entry().to_app_option::<DeliveryOrder>() {
        if order.status != DeliveryStatus::Delivered {
            return Ok(Err(not_yet_delivered_msg.into()));
        }
        let mut valid_subjects = vec![order.merchant.clone()];
        if let Some(bid_ref) = &order.accepted_bid {
            let bid_record = must_get_valid_record(bid_ref.clone())?;
            let Ok(Some(bid)) = bid_record.entry().to_app_option::<Bid>() else {
                return Ok(Err("accepted_bid does not point at a Bid entry".into()));
            };
            valid_subjects.push(bid.bidder);
        }
        return Ok(Ok(ReviewableOrder { requester: order.requester, item_refs: order.item_refs, valid_subjects }));
    }
    if let Ok(Some(order)) = order_record.entry().to_app_option::<PickupOrder>() {
        if order.status != PickupStatus::PickedUp {
            return Ok(Err(not_yet_picked_up_msg.into()));
        }
        return Ok(Ok(ReviewableOrder { requester: order.requester, item_refs: order.item_refs, valid_subjects: vec![order.merchant] }));
    }
    Ok(Err("order_ref does not point at a DeliveryOrder or PickupOrder entry".into()))
}

/// Same shape as `validate_review`, plus the one extra check that
/// distinguishes an item rating from a plain agent review: `item_ref` must
/// actually be one of the order's own `item_refs`, checked deterministically
/// since `order_ref` is already resolved (by the coordinator) to the
/// order's real, immutable-at-this-point item list.
fn validate_item_review(review: &ItemReview, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if review.rating < 1 || review.rating > 5 {
        return Ok(ValidateCallbackResult::Invalid("rating must be between 1 and 5".into()));
    }
    if &review.author != author {
        return Ok(ValidateCallbackResult::Invalid(
            "an item review's author field must match the actual action author".into(),
        ));
    }
    let order = match resolve_reviewable_order(
        &review.order_ref,
        "an item can only be reviewed against a Delivered order",
        "an item can only be reviewed against a PickedUp order",
    )? {
        Ok(order) => order,
        Err(reason) => return Ok(ValidateCallbackResult::Invalid(reason)),
    };
    if &order.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "only the order's requester may review an item from it".into(),
        ));
    }
    if !order.item_refs.contains(&review.item_ref) {
        return Ok(ValidateCallbackResult::Invalid(
            "item_ref must have actually been part of the reviewed order".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Same discipline as `validate_checkpoint`: can't be fabricated
/// independent of a real, already-validated `ItemReview`.
fn validate_item_rating_checkpoint(checkpoint: &ItemRatingCheckpoint, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let review_record = must_get_valid_record(checkpoint.related_review.clone())?;
    let Ok(Some(review)) = review_record.entry().to_app_option::<ItemReview>() else {
        return Ok(ValidateCallbackResult::Invalid("related_review does not point at an ItemReview entry".into()));
    };
    if checkpoint.item_ref != review.item_ref {
        return Ok(ValidateCallbackResult::Invalid(
            "checkpoint item_ref must match related_review's own item_ref".into(),
        ));
    }
    if author != &review.author {
        return Ok(ValidateCallbackResult::Invalid(
            "a checkpoint can only be authored by related_review's own author".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Only the order's requester may review, only about the order's actual
/// merchant or accepted driver, and only once the order is genuinely
/// `Delivered` -- `order_ref` is the order's *original* creation action, so
/// `must_get_valid_record` on it alone would only ever show the as-created
/// `Open` record (the same literalness this codebase has hit repeatedly --
/// see `HOLOCHAIN_ISSUES.md` #4). There's no non-deterministic "current
/// status" query available in validate() to work around that with, so the
/// caller is trusted to pass the order's *own latest update action* here as
/// `order_ref` -- `must_get_valid_record` on that specific, named action is
/// still fully deterministic (a fixed, content-addressed hash), it's just
/// the coordinator's job to have resolved it to the right one first.
fn validate_review(review: &Review, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if review.rating < 1 || review.rating > 5 {
        return Ok(ValidateCallbackResult::Invalid("rating must be between 1 and 5".into()));
    }
    if &review.author != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a review's author field must match the actual action author".into(),
        ));
    }
    let order = match resolve_reviewable_order(
        &review.order_ref,
        "a review can only be left against a Delivered order",
        "a review can only be left against a PickedUp order",
    )? {
        Ok(order) => order,
        Err(reason) => return Ok(ValidateCallbackResult::Invalid(reason)),
    };
    if &order.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "only the order's requester may leave a review".into(),
        ));
    }
    if !order.valid_subjects.contains(&review.subject) {
        return Ok(ValidateCallbackResult::Invalid(
            "subject must be either the order's merchant or its accepted driver".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Same discipline as `ledger`'s `validate_checkpoint`: a checkpoint can't
/// be fabricated independent of a real, already-validated event -- it must
/// reference one via `related_event`, name that event's own subject, and be
/// authored by whoever `validate_event` already trusts to author it (the
/// counterparty), reusing the exact same rule rather than a looser one.
fn validate_checkpoint(checkpoint: &ReputationCheckpoint, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let event_record = must_get_valid_record(checkpoint.related_event.clone())?;
    let Ok(Some(event)) = event_record.entry().to_app_option::<ReputationEvent>() else {
        return Ok(ValidateCallbackResult::Invalid("related_event does not point at a ReputationEvent entry".into()));
    };
    if checkpoint.subject != event.subject {
        return Ok(ValidateCallbackResult::Invalid(
            "checkpoint subject must match related_event's own subject".into(),
        ));
    }
    if author != &event.counterparty {
        return Ok(ValidateCallbackResult::Invalid(
            "a checkpoint can only be authored by related_event's own counterparty".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_event(event: &ReputationEvent, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if event.subject == event.counterparty {
        return Ok(ValidateCallbackResult::Invalid(
            "subject and counterparty must be different agents".into(),
        ));
    }
    // Only the counterparty may record an event about someone -- never the
    // subject about themselves. This stops self-flattery but is still just a
    // single-party claim; see the doc comment above on why it's a cache, not
    // ground truth.
    if author != &event.counterparty {
        return Ok(ValidateCallbackResult::Invalid(
            "a reputation event can only be authored by the counterparty, not the subject".into(),
        ));
    }
    must_get_valid_record(event.order_ref.clone())?;
    Ok(ValidateCallbackResult::Valid)
}
