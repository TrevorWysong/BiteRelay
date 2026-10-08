//! Integrity zome for reputation: append-only `ReputationEvent`s -- see the
//! type's doc comment for why this is a cache, not the trust source of
//! truth, and why append-only rather than a mutable score.
//!
//! Everything here is keyed by a *scoped* target (a store, or an agent in
//! one specific role), never by a bare agent pubkey. One agent can own
//! several stores and also drive, the same way one DoorDash/Uber Eats
//! business login can run several locations while a Dasher/courier account
//! is rated entirely separately -- so a store's rating must never include
//! its owner's driving, and one store's rating must never include another
//! store's. Each target gets its own link base and its own link types (see
//! `LinkTypes`), so every read below only ever walks that one target's own
//! links.

use dispatch_types::{Bid, DeliveryOrder, DeliveryStatus, PickupOrder, PickupStatus};
use hdi::prelude::*;

mod links;

/// Who a `ReputationEvent` (and its checkpoint) is about.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum ReputationTarget {
    /// A store, by its catalog's *original* creation action -- the same
    /// stable `catalog_ref` every order, menu item and promo code already
    /// uses. The subject agent is the order's merchant, which
    /// `dispatch_integrity` guarantees owns this catalog.
    Store(ActionHash),
    /// An agent acting as a delivery driver (an order's accepted bidder).
    Driver(AgentPubKey),
    /// An agent acting as a customer (an order's requester).
    Customer(AgentPubKey),
}

/// Who a `Review` (and its rating checkpoint) is about -- the two things a
/// customer actually rates after an order, same as the DoorDash/Uber Eats
/// post-order prompt: the store, and (for a delivery) the driver.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum ReviewTarget {
    Store(ActionHash),
    Driver(AgentPubKey),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum ReputationEventKind {
    /// No role field: the event's `ReputationTarget` already says which
    /// role (or which store) this completion counts toward.
    OrderCompleted,
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
    pub target: ReputationTarget,
    pub counterparty: AgentPubKey,
    /// The order's *original* creation action -- every field
    /// `validate_event` checks against it (`requester`, `merchant`,
    /// `catalog_ref`) is fixed at creation, so the literal as-created record
    /// is exactly the right reference point.
    pub order_ref: ActionHash,
    pub kind: ReputationEventKind,
    pub recorded_at: Timestamp,
}

/// A periodic, append-only "summary as of `related_event`" breadcrumb --
/// the exact same pattern, for the exact same reasons, as `ledger`'s
/// `BalanceCheckpoint` (architecture plan §9.4): `get_reputation_summary`
/// finds the most recent one instead of rescanning a target's *entire*
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
    pub target: ReputationTarget,
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
/// variant, since a review is customer-facing content (shown on a store's
/// page, a driver's bid), not an internal trust signal like the existing
/// event log. Same posture as that log, though: self-authored by the
/// reviewer, so it's a UI-display feature, not a cryptographically-enforced
/// fact -- nothing stops a rating from being unfair, only from being
/// fabricated by someone who wasn't a party to the order at all, or aimed
/// at a store/driver that wasn't actually part of it (see `validate_review`
/// below).
#[hdk_entry_helper]
#[derive(Clone)]
pub struct Review {
    pub target: ReviewTarget,
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

/// `ItemRatingCheckpoint`'s sibling for store/driver `Review`s -- what makes
/// a store's star rating on a Browse card a bounded read instead of
/// fetching and averaging every review that store has ever received.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct RatingCheckpoint {
    pub target: ReviewTarget,
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
    RatingCheckpoint(RatingCheckpoint),
}

/// One link type per (target kind, purpose) rather than one shared type
/// per purpose: a `Driver` and a `Customer` target share the same base (the
/// agent's pubkey), so a single `AgentToEvent` link type would mix the two
/// roles on every read. A store's links hang off its catalog's original action instead.
#[hdk_link_types]
pub enum LinkTypes {
    StoreToEvent,
    DriverToEvent,
    CustomerToEvent,
    StoreToReputationCheckpoint,
    DriverToReputationCheckpoint,
    CustomerToReputationCheckpoint,
    StoreToReview,
    DriverToReview,
    StoreToRatingCheckpoint,
    DriverToRatingCheckpoint,
    /// From an order's *original* action to every store/driver review left
    /// on it -- lets `submit_review` refuse a second review of the same
    /// target for the same order, and lets the customer's own order screen
    /// know it's already been rated (DoorDash/Uber Eats both rate an order
    /// exactly once).
    OrderToReview,
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
            EntryTypes::RatingCheckpoint(checkpoint) => validate_rating_checkpoint(&checkpoint, action.author()),
        },
        FlatOp::Link(OpLink::CreateLink { link_type, action }) => links::validate_create_link(link_type, &action.base_address, &action.target_address, action.author()),
        FlatOp::Link(OpLink::DeleteLink { .. }) => links::validate_delete_link(),
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

/// The creation-time facts every validation here needs from an order,
/// whichever vertical it is -- all fixed when the order is created, so the
/// literal record `must_get_valid_record` returns is enough for these.
struct OrderParties {
    requester: AgentPubKey,
    merchant: AgentPubKey,
    catalog_ref: ActionHash,
}

/// `Ok(None)` when `order_ref` isn't an order at all.
fn order_parties(order_ref: &ActionHash) -> ExternResult<Option<OrderParties>> {
    let record = must_get_valid_record(order_ref.clone())?;
    if let Ok(Some(order)) = record.entry().to_app_option::<DeliveryOrder>() {
        return Ok(Some(OrderParties { requester: order.requester, merchant: order.merchant, catalog_ref: order.catalog_ref }));
    }
    if let Ok(Some(order)) = record.entry().to_app_option::<PickupOrder>() {
        return Ok(Some(OrderParties { requester: order.requester, merchant: order.merchant, catalog_ref: order.catalog_ref }));
    }
    Ok(None)
}

/// What `validate_review`/`validate_item_review` both need from whichever
/// order type `order_ref` actually resolves to -- a `Review`/`ItemReview`
/// is generic over which vertical it's about (see `Dispute`'s own doc
/// comment in `dispute_integrity` for the identical reasoning), so this
/// resolves either `DeliveryOrder` or `PickupOrder` to the same shape
/// rather than duplicating both review functions once per order type.
struct ReviewableOrder {
    requester: AgentPubKey,
    merchant: AgentPubKey,
    catalog_ref: ActionHash,
    /// The items ordered (each line's item identity).
    item_refs: Vec<ActionHash>,
    /// The accepted driver, for a delivery -- pickup has no driver at all.
    driver: Option<AgentPubKey>,
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
        let driver = match &order.accepted_bid {
            Some(bid_ref) => {
                let bid_record = must_get_valid_record(bid_ref.clone())?;
                let Ok(Some(bid)) = bid_record.entry().to_app_option::<Bid>() else {
                    return Ok(Err("accepted_bid does not point at a Bid entry".into()));
                };
                Some(bid.bidder)
            }
            None => None,
        };
        return Ok(Ok(ReviewableOrder {
            requester: order.requester,
            merchant: order.merchant,
            catalog_ref: order.catalog_ref,
            item_refs: order.lines.into_iter().map(|line| line.item_ref).collect(),
            driver,
        }));
    }
    if let Ok(Some(order)) = order_record.entry().to_app_option::<PickupOrder>() {
        if order.status != PickupStatus::PickedUp {
            return Ok(Err(not_yet_picked_up_msg.into()));
        }
        return Ok(Ok(ReviewableOrder {
            requester: order.requester,
            merchant: order.merchant,
            catalog_ref: order.catalog_ref,
            item_refs: order.lines.into_iter().map(|line| line.item_ref).collect(),
            driver: None,
        }));
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
    // Same self-flattery rule as `validate_review`'s store case: a
    // merchant's own self-order can't rate their own menu.
    if &order.merchant == author {
        return Ok(ValidateCallbackResult::Invalid("a merchant cannot review items from their own store".into()));
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

/// Same discipline again, for store/driver rating checkpoints.
fn validate_rating_checkpoint(checkpoint: &RatingCheckpoint, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let review_record = must_get_valid_record(checkpoint.related_review.clone())?;
    let Ok(Some(review)) = review_record.entry().to_app_option::<Review>() else {
        return Ok(ValidateCallbackResult::Invalid("related_review does not point at a Review entry".into()));
    };
    if checkpoint.target != review.target {
        return Ok(ValidateCallbackResult::Invalid(
            "checkpoint target must match related_review's own target".into(),
        ));
    }
    if author != &review.author {
        return Ok(ValidateCallbackResult::Invalid(
            "a checkpoint can only be authored by related_review's own author".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Only the order's requester may review, only once the order is genuinely
/// `Delivered`/`PickedUp`, and only about a target that was actually part
/// of it: a `Store` review must name the order's own store (never another
/// store the same owner runs), a `Driver` review the order's own accepted
/// driver. `order_ref` is the order's *latest* action, not its original
/// creation action -- `must_get_valid_record` is literal, so the as-created
/// record would only ever show the initial status (the same literalness
/// this codebase has hit repeatedly -- see `HOLOCHAIN_ISSUES.md` #4).
/// There's no non-deterministic "current status" query available in
/// validate() to work around that with, so the caller is trusted to pass
/// the order's *own latest update action* here -- `must_get_valid_record`
/// on that specific, named action is still fully deterministic (a fixed,
/// content-addressed hash), it's just the coordinator's job to have
/// resolved it to the right one first.
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
    match &review.target {
        ReviewTarget::Store(catalog_ref) => {
            if catalog_ref != &order.catalog_ref {
                return Ok(ValidateCallbackResult::Invalid(
                    "a store review must name the store this order was actually placed with".into(),
                ));
            }
            // A merchant ordering from their own store is allowed (see
            // `dispatch::settle_order_total`), but rating it would be pure
            // self-flattery.
            if &order.merchant == author {
                return Ok(ValidateCallbackResult::Invalid("a merchant cannot review their own store".into()));
            }
        }
        ReviewTarget::Driver(driver) => {
            if order.driver.as_ref() != Some(driver) {
                return Ok(ValidateCallbackResult::Invalid(
                    "a driver review must name this order's own accepted driver".into(),
                ));
            }
        }
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Same discipline as `ledger`'s `validate_checkpoint`: a checkpoint can't
/// be fabricated independent of a real, already-validated event -- it must
/// reference one via `related_event`, name that event's own target, and be
/// authored by whoever `validate_event` already trusts to author it (the
/// counterparty), reusing the exact same rule rather than a looser one.
fn validate_checkpoint(checkpoint: &ReputationCheckpoint, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let event_record = must_get_valid_record(checkpoint.related_event.clone())?;
    let Ok(Some(event)) = event_record.entry().to_app_option::<ReputationEvent>() else {
        return Ok(ValidateCallbackResult::Invalid("related_event does not point at a ReputationEvent entry".into()));
    };
    if checkpoint.target != event.target {
        return Ok(ValidateCallbackResult::Invalid(
            "checkpoint target must match related_event's own target".into(),
        ));
    }
    if author != &event.counterparty {
        return Ok(ValidateCallbackResult::Invalid(
            "a checkpoint can only be authored by related_event's own counterparty".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Ties each target to the order it's recorded against: a `Store` event
/// must name that order's own store, a `Customer` event that order's own
/// requester. A `Driver` target can't be checked the same way here --
/// `order_ref` is the order's original action, which never has an
/// `accepted_bid` yet (see `validate_review`'s doc comment for the
/// literalness behind that) -- so it gets the same counterparty-only trust
/// this whole log has always had (see `ReputationEvent`'s doc comment).
fn validate_event(event: &ReputationEvent, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    // Only the counterparty may record an event about someone -- never the
    // subject about themselves. This stops self-flattery but is still just a
    // single-party claim; see the doc comment above on why it's a cache, not
    // ground truth.
    if author != &event.counterparty {
        return Ok(ValidateCallbackResult::Invalid(
            "a reputation event can only be authored by the counterparty, not the subject".into(),
        ));
    }
    let Some(order) = order_parties(&event.order_ref)? else {
        return Ok(ValidateCallbackResult::Invalid(
            "order_ref does not point at a DeliveryOrder or PickupOrder entry".into(),
        ));
    };
    let subject = match &event.target {
        ReputationTarget::Store(catalog_ref) => {
            if catalog_ref != &order.catalog_ref {
                return Ok(ValidateCallbackResult::Invalid(
                    "a store reputation event must name the store this order was placed with".into(),
                ));
            }
            order.merchant
        }
        ReputationTarget::Customer(customer) => {
            if customer != &order.requester {
                return Ok(ValidateCallbackResult::Invalid(
                    "a customer reputation event must name this order's own requester".into(),
                ));
            }
            customer.clone()
        }
        ReputationTarget::Driver(driver) => driver.clone(),
    };
    if &subject == author {
        return Ok(ValidateCallbackResult::Invalid(
            "subject and counterparty must be different agents".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}
