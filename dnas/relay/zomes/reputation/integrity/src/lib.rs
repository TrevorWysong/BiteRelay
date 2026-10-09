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
use relay_integrity_support::{first_problem, text_problem};
use relay_integrity_support::{classify, decode, original_creation, Checked};

mod links;

/// Who a `ReputationEvent` is about.
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

/// Who a `Review` is about -- the two things a
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
    /// A version of the order that shows who its parties are -- including
    /// its driver, which only a version after acceptance names. Validation
    /// checks the author is one of them (or an arbitrator, for a ruling).
    pub basis: ActionHash,
    pub kind: ReputationEventKind,
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



#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    ReputationEvent(ReputationEvent),
    Review(Review),
    ItemReview(ItemReview),
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
    StoreToReview,
    DriverToReview,
    /// From an order's *original* action to every store/driver review left
    /// on it -- lets `submit_review` refuse a second review of the same
    /// target for the same order, and lets the customer's own order screen
    /// know it's already been rated (DoorDash/Uber Eats both rate an order
    /// exactly once).
    OrderToReview,
    ItemToReview,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match classify(op.flattened::<EntryTypes, LinkTypes>()?)? {
        Checked::Create { entry, action } => match entry {
            EntryTypes::ReputationEvent(event) => validate_event(&event, action.author()),
            EntryTypes::Review(review) => validate_review(&review, action.author()),
            EntryTypes::ItemReview(review) => validate_item_review(&review, action.author()),
        },
        // Reputation is an append-only record.
        Checked::Update { .. } => Ok(ValidateCallbackResult::Invalid("reputation entries can't be changed".into())),
        Checked::Delete { .. } => Ok(ValidateCallbackResult::Invalid("reputation entries can't be deleted".into())),
        Checked::CreateLink { link_type, action } => links::validate_create_link(link_type, &action.base_address, &action.target_address, &action.tag, action.author()),
        Checked::DeleteLink { .. } => links::validate_delete_link(),
        Checked::Other => Ok(ValidateCallbackResult::Valid),
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
    if let Some(invalid) = first_problem([text_problem("comment", &review.comment, 2_000)]) {
        return Ok(invalid);
    }
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
    if let Some(invalid) = first_problem([text_problem("comment", &review.comment, 2_000)]) {
        return Ok(invalid);
    }
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


/// Only someone who took part in the order records an event about it --
/// its customer, store or driver, never the subject about themselves -- and
/// only an arbitrator records a ruling's outcome. `basis` is a version of
/// the order showing its parties: the driver only appears once a bid is
/// accepted. Each target must be that order's own store, customer or driver.
fn validate_event(event: &ReputationEvent, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if author != &event.counterparty {
        return Ok(ValidateCallbackResult::Invalid("a reputation event's counterparty must be its author".into()));
    }
    if original_creation(event.basis.clone())? != event.order_ref {
        return Ok(ValidateCallbackResult::Invalid("an event's basis must be a version of its own order".into()));
    }
    let basis = must_get_valid_record(event.basis.clone())?;
    let (requester, merchant, catalog_ref, driver) = if let Some(order) = decode::<DeliveryOrder>(&basis) {
        let driver = match &order.accepted_bid {
            Some(bid_ref) => decode::<Bid>(&must_get_valid_record(bid_ref.clone())?).map(|bid| bid.bidder),
            None => None,
        };
        (order.requester, order.merchant, order.catalog_ref, driver)
    } else if let Some(order) = decode::<PickupOrder>(&basis) {
        (order.requester, order.merchant, order.catalog_ref, None)
    } else {
        return Ok(ValidateCallbackResult::Invalid("an event's basis must be an order".into()));
    };
    let subject = match &event.target {
        ReputationTarget::Store(store) if store == &catalog_ref => merchant.clone(),
        ReputationTarget::Customer(customer) if customer == &requester => customer.clone(),
        ReputationTarget::Driver(agent) if Some(agent) == driver.as_ref() => agent.clone(),
        _ => return Ok(ValidateCallbackResult::Invalid("an event must be about this order's own store, customer or driver".into())),
    };
    if &subject == author {
        return Ok(ValidateCallbackResult::Invalid("subject and counterparty must be different agents".into()));
    }
    let ruling = matches!(event.kind, ReputationEventKind::DisputeResolvedAgainst | ReputationEventKind::CollateralForfeited { .. });
    let party = author == &requester || author == &merchant || Some(author) == driver.as_ref();
    let allowed = if ruling { relay_governance::is_arbitrator(author)? } else { party };
    if !allowed {
        return Ok(ValidateCallbackResult::Invalid("only the order's own parties record events about it, and only an arbitrator a ruling's outcome".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// What a review's link carries, so a rating is one link read summed --
/// never a summary someone else wrote. Validation checks it matches the
/// review it points at.
pub fn review_tag(rating: u8, order_original: &ActionHash) -> LinkTag {
    let mut bytes = vec![rating];
    bytes.extend_from_slice(order_original.get_raw_39());
    LinkTag::new(bytes)
}

/// The same for a reputation event: its kind, the amount (for a forfeit)
/// and the order.
pub fn event_tag(kind: &ReputationEventKind, order_original: &ActionHash) -> LinkTag {
    let (code, amount) = match kind {
        ReputationEventKind::OrderCompleted => (0u8, 0u64),
        ReputationEventKind::OrderCancelledByThem => (1, 0),
        ReputationEventKind::DisputeRaised => (2, 0),
        ReputationEventKind::DisputeResolvedAgainst => (3, 0),
        ReputationEventKind::CollateralForfeited { amount } => (4, *amount),
    };
    let mut bytes = vec![code];
    bytes.extend_from_slice(&amount.to_be_bytes());
    bytes.extend_from_slice(order_original.get_raw_39());
    LinkTag::new(bytes)
}
