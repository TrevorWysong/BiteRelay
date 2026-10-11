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

use dispatch_types::{Bid, Cancellation, DeliveryOrder, DeliveryStatus, OrderOutcome, Outcome, PickupOrder, PickupStatus};
use hdi::prelude::*;
use relay_integrity_support::chain::entries_since;
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
    /// A driver who left a delivery they'd committed to before picking it
    /// up -- dropping it, or moved on by the store once they were late.
    /// Recorded by the customer, on the version that released them: a
    /// driver's completion rate.
    DeliveryDropped,
    /// A store that kept a checked-in driver waiting past its wait.
    /// Recorded by that driver, on their update leaving it late.
    StoreLate,
    /// A driver's report that a store wouldn't check them in -- which the
    /// network can't check, so it moves no money: the store answers to it
    /// in what drivers and customers see. Recorded by a driver the order's
    /// customer accepted, on a version naming them.
    CheckInRefused,
    /// A driver whose bid was accepted who never committed -- they let the
    /// offer lapse, or turned it down. Recorded by the customer, on the
    /// version releasing them: what automatic matching weighs.
    OfferLapsed,
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
    /// its driver, which only a version after acceptance names -- or, for
    /// an outcome only the store records, its `OrderOutcome`. Validation
    /// checks the author is one of them.
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
            EntryTypes::Review(review) => validate_review(&review, action.author(), action.prev_action()),
            EntryTypes::ItemReview(review) => validate_item_review(&review, action.author(), action.prev_action()),
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
/// is generic over which vertical it's about, so this
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
        if !matches!(order.status, DeliveryStatus::Delivered | DeliveryStatus::Collected) {
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
fn validate_item_review(review: &ItemReview, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    if let Some(invalid) = first_problem([text_problem("comment", &review.comment, relay_integrity_support::limits::MAX_DESCRIPTION_CHARS)]) {
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
    let item = review.item_ref.clone();
    if reviewed_before::<ItemReview>(author, prev_action, &review.order_ref, UnitEntryTypes::ItemReview, |earlier| earlier.item_ref == item, |earlier| &earlier.order_ref)? {
        return Ok(ValidateCallbackResult::Invalid("an item is reviewed once per order".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Whether `author` already wrote a review of type `T` about the same order
/// as `order_ref` (any version of it) for which `same_subject` holds --
/// reviews are once per order and subject, so nobody can bury a store's,
/// a driver's or an item's reviews in their own. Walked on their chain
/// since the order was placed.
fn reviewed_before<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(
    author: &AgentPubKey,
    prev_action: Option<&ActionHash>,
    order_ref: &ActionHash,
    unit: UnitEntryTypes,
    same_subject: impl Fn(&T) -> bool,
    order_of: impl Fn(&T) -> &ActionHash,
) -> ExternResult<bool> {
    let Some(prev) = prev_action else { return Ok(false) };
    let order = original_creation(order_ref.clone())?;
    let placed = must_get_action(order.clone())?.hashed.content.header.timestamp;
    for bytes in entries_since(author, prev, placed, &[unit.try_into()?])? {
        let Ok(earlier) = T::try_from(bytes) else { continue };
        if same_subject(&earlier) && original_creation(order_of(&earlier).clone())? == order {
            return Ok(true);
        }
    }
    Ok(false)
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
fn validate_review(review: &Review, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    if let Some(invalid) = first_problem([text_problem("comment", &review.comment, relay_integrity_support::limits::MAX_DESCRIPTION_CHARS)]) {
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
    if reviewed_before::<Review>(author, prev_action, &review.order_ref, UnitEntryTypes::Review, |earlier| earlier.target == review.target, |earlier| &earlier.order_ref)? {
        return Ok(ValidateCallbackResult::Invalid("an order's store and driver are each reviewed once".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}


/// Every event must match what happened, as a record shows it -- its
/// `basis`, either a version of the order or its store's decision
/// (`OrderOutcome`):
///
/// - **OrderCompleted** -- for a store, recorded by whoever completed the
///   order, citing the version that completed it; for a driver, recorded by
///   the store, citing its decision that the order was delivered.
/// - **OrderCancelledByThem** -- recorded by another of the order's parties,
///   citing the update that cancelled it, against whoever cancelled.
/// - **DisputeRaised** -- recorded by the customer, citing their claim that
///   a delivery never arrived, against its driver.
/// - **DisputeResolvedAgainst** -- recorded by the store, citing its
///   decision: against the driver of an order that never arrived, or the
///   customer who claimed one never arrived that had.
/// - **CollateralForfeited** -- recorded by the store, citing its decision
///   that an order never arrived, for exactly the driver's collateral.
///
/// Never by the subject about themselves.
fn validate_event(event: &ReputationEvent, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if author != &event.counterparty {
        return Ok(ValidateCallbackResult::Invalid("a reputation event's counterparty must be its author".into()));
    }
    let basis = must_get_valid_record(event.basis.clone())?;
    // The order version showing the parties, and the store's decision when
    // the event rests on one.
    let (version, outcome) = match decode::<OrderOutcome>(&basis) {
        Some(outcome) => {
            if outcome.order != event.order_ref {
                return Ok(ValidateCallbackResult::Invalid("an event's basis must be about its own order".into()));
            }
            let cited = match &outcome.outcome {
                Outcome::Delivered { proof } => proof.clone(),
                Outcome::NotDelivered { claim } => claim.clone(),
            };
            (must_get_valid_record(cited)?, Some(outcome.outcome))
        }
        None => {
            if original_creation(event.basis.clone())? != event.order_ref {
                return Ok(ValidateCallbackResult::Invalid("an event's basis must be a version of its own order".into()));
            }
            (basis, None)
        }
    };
    let Some(order) = Parties::of(&version)? else {
        return Ok(ValidateCallbackResult::Invalid("an event's basis must be an order".into()));
    };
    let subject = match &event.target {
        ReputationTarget::Store(store) if store == &order.catalog_ref => order.merchant.clone(),
        ReputationTarget::Customer(customer) if customer == &order.requester => customer.clone(),
        ReputationTarget::Driver(agent) if order.driver.as_ref() == Some(agent) || order.released_driver.as_ref() == Some(agent) => agent.clone(),
        _ => return Ok(ValidateCallbackResult::Invalid("an event must be about this order's own store, customer or driver".into())),
    };
    if &subject == author {
        return Ok(ValidateCallbackResult::Invalid("subject and counterparty must be different agents".into()));
    }
    let by_store = author == &order.merchant;
    let at_driver = matches!(event.target, ReputationTarget::Driver(_));
    let at_store = matches!(event.target, ReputationTarget::Store(_));
    let at_customer = matches!(event.target, ReputationTarget::Customer(_));
    let allowed = match (&event.kind, &outcome) {
        // A completed order, credited to its store by whoever completed it --
        // or by its customer, who has it whoever wrote that version.
        (ReputationEventKind::OrderCompleted, None) => at_store && order.completed && (version.action().author() == author || author == &order.requester),
        (ReputationEventKind::OrderCompleted, Some(Outcome::Delivered { .. })) => at_driver && by_store,
        (ReputationEventKind::OrderCancelledByThem, None) => order.cancelled_by.as_ref() == Some(&subject) && cancelled_here(&version)? && order.is_party(author),
        // A driver who left because the store was late didn't drop it.
        (ReputationEventKind::DeliveryDropped, None) => at_driver && order.released_driver.as_ref() == Some(&subject) && order.released_committed && order.called_late_by.is_none() && author == &order.requester,
        (ReputationEventKind::StoreLate, None) => at_store && order.called_late_by.as_ref() == Some(author),
        (ReputationEventKind::OfferLapsed, None) => at_driver && order.released_driver.as_ref() == Some(&subject) && !order.released_committed && author == &order.requester,
        (ReputationEventKind::CheckInRefused, None) => at_store && (order.driver.as_ref() == Some(author) || order.released_driver.as_ref() == Some(author)),
        (ReputationEventKind::DisputeRaised, None) => at_driver && order.claimed && version.action().author() == author && author == &order.requester,
        (ReputationEventKind::DisputeResolvedAgainst, Some(Outcome::NotDelivered { .. })) => at_driver && by_store,
        (ReputationEventKind::DisputeResolvedAgainst, Some(Outcome::Delivered { proof })) => at_customer && by_store && claimed_before(proof)?,
        (ReputationEventKind::CollateralForfeited { amount }, Some(Outcome::NotDelivered { .. })) => at_driver && by_store && Some(*amount) == order.collateral,
        _ => false,
    };
    if !allowed {
        return Ok(ValidateCallbackResult::Invalid("only the order's own parties record events about it, as its records show them, and only its store an outcome".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// An order's parties and state, as one version of it shows them.
struct Parties {
    requester: AgentPubKey,
    merchant: AgentPubKey,
    catalog_ref: ActionHash,
    /// The accepted driver, once there is one.
    driver: Option<AgentPubKey>,
    /// What the driver posts as collateral, once there is one.
    collateral: Option<u64>,
    /// Delivered, or collected.
    completed: bool,
    /// The driver this version released, before they picked it up.
    released_driver: Option<AgentPubKey>,
    /// Whether that driver had committed to it (their collateral held).
    released_committed: bool,
    /// The driver who called the store late, if this version does.
    called_late_by: Option<AgentPubKey>,
    /// The customer's claim that a delivery never arrived.
    claimed: bool,
    /// Who cancelled it, if this version is cancelled.
    cancelled_by: Option<AgentPubKey>,
}

impl Parties {
    fn of(version: &Record) -> ExternResult<Option<Self>> {
        if let Some(order) = decode::<DeliveryOrder>(version) {
            let bid = match &order.accepted_bid {
                Some(bid_ref) => decode::<Bid>(&must_get_valid_record(bid_ref.clone())?),
                None => None,
            };
            let cancelled_by = canceller(&order.cancellation, &order.requester, &order.merchant);
            let (released_driver, released_committed) = released_driver(version, &order)?.unzip();
            // A driver leaving because the store kept them waiting.
            let late = match dispatch_types::lineage::Version::of(version.clone()) {
                Some(v) => match v.prior()? {
                    Some(p) => dispatch_types::lineage::is_store_late_release(&v, &p)?,
                    None => false,
                },
                None => false,
            };
            let called_late_by = late.then(|| version.action().author().clone());
            return Ok(Some(Self {
                released_driver,
                released_committed: released_committed.unwrap_or(false),
                called_late_by,
                driver: bid.as_ref().map(|b| b.bidder.clone()),
                collateral: bid.map(|b| b.collateral),
                completed: matches!(order.status, DeliveryStatus::Delivered | DeliveryStatus::Collected),
                claimed: order.status == DeliveryStatus::Disputed,
                cancelled_by: (order.status == DeliveryStatus::Cancelled).then_some(cancelled_by).flatten(),
                requester: order.requester,
                merchant: order.merchant,
                catalog_ref: order.catalog_ref,
            }));
        }
        if let Some(order) = decode::<PickupOrder>(version) {
            let cancelled_by = canceller(&order.cancellation, &order.requester, &order.merchant);
            return Ok(Some(Self {
                released_driver: None,
                released_committed: false,
                called_late_by: None,
                driver: None,
                collateral: None,
                completed: order.status == PickupStatus::PickedUp,
                claimed: false,
                cancelled_by: (order.status == PickupStatus::Cancelled).then_some(cancelled_by).flatten(),
                requester: order.requester,
                merchant: order.merchant,
                catalog_ref: order.catalog_ref,
            }));
        }
        Ok(None)
    }

    fn is_party(&self, agent: &AgentPubKey) -> bool {
        agent == &self.requester || agent == &self.merchant || self.driver.as_ref() == Some(agent)
    }
}

/// Who a cancellation says cancelled the order.
fn canceller(cancellation: &Option<Cancellation>, requester: &AgentPubKey, merchant: &AgentPubKey) -> Option<AgentPubKey> {
    match cancellation.as_ref()? {
        // Never collecting an order they chose to collect is the customer's
        // cancelling, though the store records it.
        Cancellation::ByCustomer | Cancellation::NotCollected => Some(requester.clone()),
        Cancellation::ByStore(_) | Cancellation::StoreDidNotRespond | Cancellation::StoreLate => Some(merchant.clone()),
        // A driver's doing, recorded as a drop.
        Cancellation::NoDriver => None,
    }
}

/// Whether `version` is the update that cancelled its order -- not a later
/// version carrying the cancellation forward.
fn cancelled_here(version: &Record) -> ExternResult<bool> {
    let ActionData::Update(update) = &version.action().data else { return Ok(false) };
    let prior = must_get_valid_record(update.original_action_address.clone())?;
    Ok(Parties::of(&prior)?.is_some_and(|p| p.cancelled_by.is_none()))
}

/// Whether the delivered version `proof` came out of the customer's claim
/// that it never arrived.
fn claimed_before(proof: &ActionHash) -> ExternResult<bool> {
    let record = must_get_valid_record(proof.clone())?;
    let ActionData::Update(update) = &record.action().data else { return Ok(false) };
    Ok(decode::<DeliveryOrder>(&must_get_valid_record(update.original_action_address.clone())?).is_some_and(|prior| prior.status == DeliveryStatus::Disputed))
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
        ReputationEventKind::DeliveryDropped => (5, 0),
        ReputationEventKind::StoreLate => (6, 0),
        ReputationEventKind::CheckInRefused => (7, 0),
        ReputationEventKind::OfferLapsed => (8, 0),
    };
    let mut bytes = vec![code];
    bytes.extend_from_slice(&amount.to_be_bytes());
    bytes.extend_from_slice(order_original.get_raw_39());
    LinkTag::new(bytes)
}

/// The driver `version` released, if it's the version releasing one: its
/// prior version named an accepted bid, and it reopened the order (or
/// turned it over to its customer to collect) without one -- and whether
/// they'd committed to it.
fn released_driver(version: &Record, order: &DeliveryOrder) -> ExternResult<Option<(AgentPubKey, bool)>> {
    let ActionData::Update(update) = &version.action().data else { return Ok(None) };
    if order.accepted_bid.is_some() || !matches!(order.status, DeliveryStatus::Open | DeliveryStatus::Collecting) {
        return Ok(None);
    }
    let Some(prior) = decode::<DeliveryOrder>(&must_get_valid_record(update.original_action_address.clone())?) else { return Ok(None) };
    let Some(bid_ref) = prior.accepted_bid else { return Ok(None) };
    let committed = prior.collateral_hold.is_some();
    Ok(decode::<Bid>(&must_get_valid_record(bid_ref)?).map(|bid| (bid.bidder, committed)))
}
