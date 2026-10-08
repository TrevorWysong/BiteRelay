//! Coordinator zome for reputation: `record_event` (called by a
//! counterparty, never by the subject themselves) and `get_reputation_summary`,
//! a derived, UI-cache-only read -- see the integrity crate's doc comment
//! on why this is never the actual trust source of truth -- plus store,
//! driver and menu-item reviews with their checkpointed rating summaries.
//!
//! Every read and write is keyed by a scoped target (`ReputationTarget`/
//! `ReviewTarget`), never a bare agent -- see the integrity crate's module
//! doc comment for why.

use hdk::prelude::*;
use relay_coordinator_support::{fold_since_checkpoint, latest_checkpoint, resolve_latest, should_checkpoint};
use reputation_integrity::*;

/// Where a `ReputationTarget`'s events and checkpoints live: the link base
/// plus the two link types reserved for that kind of target.
fn event_links(target: &ReputationTarget) -> (AnyLinkableHash, LinkTypes, LinkTypes) {
    match target {
        ReputationTarget::Store(catalog_ref) => (catalog_ref.clone().into(), LinkTypes::StoreToEvent, LinkTypes::StoreToReputationCheckpoint),
        ReputationTarget::Driver(agent) => (agent.clone().into(), LinkTypes::DriverToEvent, LinkTypes::DriverToReputationCheckpoint),
        ReputationTarget::Customer(agent) => (agent.clone().into(), LinkTypes::CustomerToEvent, LinkTypes::CustomerToReputationCheckpoint),
    }
}

/// `event_links`' sibling for `ReviewTarget`: base, review link type,
/// rating-checkpoint link type.
fn review_links(target: &ReviewTarget) -> (AnyLinkableHash, LinkTypes, LinkTypes) {
    match target {
        ReviewTarget::Store(catalog_ref) => (catalog_ref.clone().into(), LinkTypes::StoreToReview, LinkTypes::StoreToRatingCheckpoint),
        ReviewTarget::Driver(agent) => (agent.clone().into(), LinkTypes::DriverToReview, LinkTypes::DriverToRatingCheckpoint),
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RecordEventInput {
    pub target: ReputationTarget,
    pub order_ref: ActionHash,
    pub kind: ReputationEventKind,
}

/// Roughly every this-many events per target, a `ReputationCheckpoint` is
/// also written -- see `ReputationCheckpoint`'s doc comment (and `ledger`'s
/// identical `CHECKPOINT_INTERVAL`) for why this is O(n/K), not O(1).
const CHECKPOINT_INTERVAL: u64 = 20;

/// Best-effort, same posture as `ledger::maybe_write_checkpoint`: purely a
/// read-side optimization, never required, so a failure here must never
/// fail the event-recording it's piggybacking on. `recorded_at` is
/// deliberately the *event's own* `recorded_at`, not a fresh `sys_time()`
/// call -- see `ledger`'s identical reasoning for why that matters for the
/// `after` boundary in `get_reputation_summary` below.
fn maybe_write_checkpoint(target: ReputationTarget, event_hash: ActionHash, event_recorded_at: Timestamp) {
    if !should_checkpoint(&event_hash, CHECKPOINT_INTERVAL) {
        return;
    }
    let Ok(summary) = get_reputation_summary(target.clone()) else { return };
    let (base, _, checkpoint_link) = event_links(&target);
    let checkpoint = ReputationCheckpoint {
        target,
        completed_count: summary.completed_count,
        cancelled_by_them_count: summary.cancelled_by_them_count,
        dispute_raised_count: summary.dispute_raised_count,
        dispute_resolved_against_count: summary.dispute_resolved_against_count,
        total_collateral_forfeited: summary.total_collateral_forfeited,
        related_event: event_hash,
        recorded_at: event_recorded_at,
    };
    if let Ok(action_hash) = create_entry(&EntryTypes::ReputationCheckpoint(checkpoint)) {
        let _ = create_link(base, action_hash, checkpoint_link, ());
    }
}

/// Called by the counterparty after a completed/cancelled/disputed order --
/// typically invoked cross-zome from `attestation` or `dispatch` once a
/// receipt or cancellation is finalized, rather than called directly by a
/// client.
#[hdk_extern]
pub fn record_event(input: RecordEventInput) -> ExternResult<Record> {
    let counterparty = agent_info()?.agent_initial_pubkey;
    let recorded_at = sys_time()?;
    let (base, event_link, _) = event_links(&input.target);
    let event = ReputationEvent {
        target: input.target.clone(),
        counterparty,
        order_ref: input.order_ref,
        kind: input.kind,
        recorded_at,
    };
    let action_hash = create_entry(&EntryTypes::ReputationEvent(event))?;
    create_link(base, action_hash.clone(), event_link, ())?;
    // get_reputation_summary (inside maybe_write_checkpoint) reads via
    // GetStrategy::Local, so it needs this event to already be visible
    // locally -- true here since we just authored it ourselves, in this
    // same call, on our own chain (the counterparty's, not the subject's).
    maybe_write_checkpoint(input.target, action_hash.clone(), recorded_at);
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back reputation event".into())))
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct ReputationSummary {
    pub completed_count: u32,
    pub cancelled_by_them_count: u32,
    pub dispute_raised_count: u32,
    pub dispute_resolved_against_count: u32,
    pub total_collateral_forfeited: u64,
}

/// A UI-display cache only -- see the integrity crate's doc comment. Do not
/// use this alone to decide whether to accept a bid; check the agent's real
/// activity chain and any outstanding warrants first.
///
/// Uses `GetStrategy::Local`, not the `Network` default -- see `ledger`'s
/// `get_balance` doc comment for why, on a small/fresh network.
///
/// Finds the most recent `ReputationCheckpoint` and sums only the events
/// since it, instead of this target's *entire* event history -- O(n/K),
/// not O(1), exactly like `ledger::get_balance` (see that function's doc
/// comment for the full reasoning, and for why `already_counted` below
/// exists: `LinkQuery.after` is `>=`, not strictly-greater).
#[hdk_extern]
pub fn get_reputation_summary(target: ReputationTarget) -> ExternResult<ReputationSummary> {
    let (base, event_link, checkpoint_link) = event_links(&target);
    let checkpoint = latest_checkpoint(base.clone(), checkpoint_link, |c: &ReputationCheckpoint| c.recorded_at)?;
    let (mut summary, since, already_counted) = match &checkpoint {
        Some(checkpoint) => (
            ReputationSummary {
                completed_count: checkpoint.completed_count,
                cancelled_by_them_count: checkpoint.cancelled_by_them_count,
                dispute_raised_count: checkpoint.dispute_raised_count,
                dispute_resolved_against_count: checkpoint.dispute_resolved_against_count,
                total_collateral_forfeited: checkpoint.total_collateral_forfeited,
            },
            Some(checkpoint.recorded_at),
            Some(checkpoint.related_event.clone()),
        ),
        None => (ReputationSummary::default(), None, None),
    };

    // Link validation already guarantees every event under this base is
    // about this target; checking again here costs nothing and keeps the
    // summary honest even if that guarantee ever regressed.
    fold_since_checkpoint::<ReputationEvent, _, _>(base, event_link, since, already_counted, &mut summary, |summary, event| {
        if event.target != target {
            return;
        }
        match event.kind {
            ReputationEventKind::OrderCompleted => summary.completed_count += 1,
            ReputationEventKind::OrderCancelledByThem => summary.cancelled_by_them_count += 1,
            ReputationEventKind::DisputeRaised => summary.dispute_raised_count += 1,
            ReputationEventKind::DisputeResolvedAgainst => summary.dispute_resolved_against_count += 1,
            ReputationEventKind::CollateralForfeited { amount } => summary.total_collateral_forfeited += amount,
        }
    })?;
    Ok(summary)
}

/// How many `ReputationCheckpoint`s exist for `target` -- genuinely useful
/// for debugging/monitoring the checkpoint mechanism itself (architecture
/// plan §9.4: is it actually engaging, roughly how often), not just a test
/// hook.
#[hdk_extern]
pub fn count_reputation_checkpoints(target: ReputationTarget) -> ExternResult<u32> {
    let (base, _, checkpoint_link) = event_links(&target);
    let links = get_links(LinkQuery::try_new(base, checkpoint_link)?, GetStrategy::Local)?;
    Ok(links.len() as u32)
}

// --- store/driver reviews ---

#[derive(Serialize, Deserialize, Debug)]
pub struct SubmitReviewInput {
    pub target: ReviewTarget,
    pub order_original_action: ActionHash,
    pub rating: u8,
    pub comment: String,
}

const RATING_CHECKPOINT_INTERVAL: u64 = 20;

/// Best-effort, same posture as every other checkpoint writer here.
fn maybe_write_rating_checkpoint(target: ReviewTarget, review_hash: ActionHash, review_created_at: Timestamp) {
    if !should_checkpoint(&review_hash, RATING_CHECKPOINT_INTERVAL) {
        return;
    }
    let Ok(summary) = get_rating_summary(target.clone()) else { return };
    let (base, _, checkpoint_link) = review_links(&target);
    let checkpoint = RatingCheckpoint {
        target,
        count: summary.count,
        rating_sum: summary.rating_sum,
        related_review: review_hash,
        recorded_at: review_created_at,
    };
    if let Ok(action_hash) = create_entry(&EntryTypes::RatingCheckpoint(checkpoint)) {
        let _ = create_link(base, action_hash, checkpoint_link, ());
    }
}

/// Every review the caller has already left on this order, via its
/// `OrderToReview` links -- a small, per-order link set (at most one store
/// review and one driver review per order).
fn my_reviews_for_order(order_original_action: &ActionHash) -> ExternResult<Vec<(Record, Review)>> {
    let me = agent_info()?.agent_initial_pubkey;
    let links = get_links(LinkQuery::try_new(order_original_action.clone(), LinkTypes::OrderToReview)?, GetStrategy::default())?;
    let mut out = Vec::new();
    for link in links {
        if link.author != me {
            continue;
        }
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash, GetOptions::default())? else { continue };
        if let Ok(Some(review)) = record.entry().to_app_option::<Review>() {
            out.push((record, review));
        }
    }
    Ok(out)
}

/// `order_original_action` is resolved to its *latest* record before being
/// written onto the `Review` as `order_ref` -- deliberately not the original
/// creation hash every other struct in this system uses for the same field
/// name, because `validate_review` needs to deterministically see the
/// order's real `Delivered` status and populated `accepted_bid`, neither of
/// which exist yet on the as-created record. Same shape as
/// `apply_dispute_resolution` advancing `dispute_ref` to a resolved action
/// for the same reason. This coordinator's own status check is a fast-fail
/// convenience; `validate_review` is what actually enforces it.
///
/// One review per target per order, same as DoorDash/Uber Eats -- checked
/// here against the caller's own `OrderToReview` links. A coordinator-level
/// rule (the same trust tier as `confirm_claim`'s quantity count): counting
/// sibling links isn't something `validate()` can do deterministically.
#[hdk_extern]
pub fn submit_review(input: SubmitReviewInput) -> ExternResult<Record> {
    if input.rating < 1 || input.rating > 5 {
        return Err(wasm_error!(WasmErrorInner::Guest("rating must be between 1 and 5".into())));
    }
    if my_reviews_for_order(&input.order_original_action)?.iter().any(|(_, r)| r.target == input.target) {
        return Err(wasm_error!(WasmErrorInner::Guest("You've already rated this order.".into())));
    }
    let order_record = resolve_latest(input.order_original_action.clone())?;
    let author = agent_info()?.agent_initial_pubkey;
    let created_at = sys_time()?;
    let review = Review {
        target: input.target.clone(),
        author,
        order_ref: order_record.action_address().clone(),
        rating: input.rating,
        comment: input.comment,
        created_at,
    };
    let action_hash = create_entry(&EntryTypes::Review(review))?;
    let (base, review_link, _) = review_links(&input.target);
    create_link(base, action_hash.clone(), review_link, ())?;
    create_link(input.order_original_action, action_hash.clone(), LinkTypes::OrderToReview, ())?;
    maybe_write_rating_checkpoint(input.target, action_hash.clone(), created_at);
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back review".into())))
}

/// What the caller has already rated on this order -- lets an order screen
/// show "thanks for rating" instead of the rating form again after a
/// reload, rather than relying on in-memory UI state.
#[hdk_extern]
pub fn get_my_reviews_for_order(order_original_action: ActionHash) -> ExternResult<Vec<Record>> {
    Ok(my_reviews_for_order(&order_original_action)?.into_iter().map(|(record, _)| record).collect())
}

const REVIEW_PAGE_SIZE: usize = 20;

#[derive(Serialize, Deserialize, Debug)]
pub struct GetReviewsInput {
    pub target: ReviewTarget,
    /// Page cursor -- pass back the previous call's `next_before` to load
    /// older reviews. `None` starts from the newest.
    pub before: Option<Timestamp>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ReviewsPage {
    pub reviews: Vec<Record>,
    pub next_before: Option<Timestamp>,
}

/// One newest-first page of the reviews linked from `base`, keeping only
/// those `belongs` accepts (link validation already guarantees it; checking
/// again keeps a list honest even if that ever regressed). `before` is
/// inclusive (`<=`, the mirror of `after`'s `>=`, see `next_page_cursor`),
/// so the next cursor steps one microsecond back from the oldest review
/// included.
fn review_page(base: AnyLinkableHash, link_type: LinkTypes, before: Option<Timestamp>, belongs: impl Fn(&Record) -> bool) -> ExternResult<ReviewsPage> {
    let mut query = LinkQuery::try_new(base, link_type)?;
    query.before = before;
    let mut links = get_links(query, GetStrategy::default())?;
    links.sort_by_key(|l| std::cmp::Reverse(l.timestamp));
    let next_before = (links.len() > REVIEW_PAGE_SIZE).then(|| Timestamp::from_micros(links[REVIEW_PAGE_SIZE - 1].timestamp.as_micros() - 1));
    links.truncate(REVIEW_PAGE_SIZE);
    let mut reviews = Vec::with_capacity(links.len());
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if let Some(record) = get(action_hash, GetOptions::default())? {
            if belongs(&record) {
                reviews.push(record);
            }
        }
    }
    Ok(ReviewsPage { reviews, next_before })
}

/// A store's or driver's reviews, newest first -- a busy store accumulates
/// reviews forever, and a store page only ever shows the most recent
/// handful (the average comes from `get_rating_summary`).
#[hdk_extern]
pub fn get_reviews_for(input: GetReviewsInput) -> ExternResult<ReviewsPage> {
    let (base, review_link, _) = review_links(&input.target);
    review_page(base, review_link, input.before, |record| {
        record.entry().to_app_option::<Review>().ok().flatten().is_some_and(|review| review.target == input.target)
    })
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct RatingSummary {
    pub count: u32,
    pub rating_sum: u32,
}

/// The star rating shown on a store card/page or a driver's bid --
/// checkpoint-accelerated, same O(n/K) pattern and `>=` double-count guard
/// as `get_reputation_summary`. See `get_item_rating_summary` for why the
/// average itself isn't stored.
#[hdk_extern]
pub fn get_rating_summary(target: ReviewTarget) -> ExternResult<RatingSummary> {
    let (base, review_link, checkpoint_link) = review_links(&target);
    let checkpoint = latest_checkpoint(base.clone(), checkpoint_link, |c: &RatingCheckpoint| c.recorded_at)?;
    let (mut summary, since, already_counted) = match &checkpoint {
        Some(checkpoint) => (
            RatingSummary { count: checkpoint.count, rating_sum: checkpoint.rating_sum },
            Some(checkpoint.recorded_at),
            Some(checkpoint.related_review.clone()),
        ),
        None => (RatingSummary::default(), None, None),
    };
    // Same belt-and-braces check as `get_reputation_summary`'s.
    fold_since_checkpoint::<Review, _, _>(base, review_link, since, already_counted, &mut summary, |summary, review| {
        if review.target != target {
            return;
        }
        summary.count += 1;
        summary.rating_sum += review.rating as u32;
    })?;
    Ok(summary)
}

// --- per-item ratings -- same shape as the store/driver reviews above,
// keyed by a MenuItem's action hash instead ---

#[derive(Serialize, Deserialize, Debug)]
pub struct SubmitItemReviewInput {
    pub item_ref: ActionHash,
    pub order_original_action: ActionHash,
    pub rating: u8,
    pub comment: String,
}

const ITEM_RATING_CHECKPOINT_INTERVAL: u64 = 20;

/// Best-effort, same posture as every other checkpoint writer in this
/// codebase: a pure read-side optimization, never required, so a failure
/// here must never fail the review submission it's piggybacking on.
fn maybe_write_item_rating_checkpoint(item_ref: ActionHash, review_hash: ActionHash, review_created_at: Timestamp) {
    if !should_checkpoint(&review_hash, ITEM_RATING_CHECKPOINT_INTERVAL) {
        return;
    }
    let Ok(summary) = get_item_rating_summary(item_ref.clone()) else { return };
    let checkpoint = ItemRatingCheckpoint {
        item_ref: item_ref.clone(),
        count: summary.count,
        rating_sum: summary.rating_sum,
        related_review: review_hash,
        recorded_at: review_created_at,
    };
    if let Ok(action_hash) = create_entry(&EntryTypes::ItemRatingCheckpoint(checkpoint)) {
        let _ = create_link(item_ref, action_hash, LinkTypes::ItemToRatingCheckpoint, ());
    }
}

/// Same `resolve_latest`-before-writing treatment as `submit_review`'s own
/// doc comment explains -- `validate_item_review` needs to deterministically
/// see the order's real `Delivered` status and final `item_refs`.
#[hdk_extern]
pub fn submit_item_review(input: SubmitItemReviewInput) -> ExternResult<Record> {
    if input.rating < 1 || input.rating > 5 {
        return Err(wasm_error!(WasmErrorInner::Guest("rating must be between 1 and 5".into())));
    }
    let order_record = resolve_latest(input.order_original_action)?;
    let author = agent_info()?.agent_initial_pubkey;
    let created_at = sys_time()?;
    let review = ItemReview {
        item_ref: input.item_ref.clone(),
        author,
        order_ref: order_record.action_address().clone(),
        rating: input.rating,
        comment: input.comment,
        created_at,
    };
    let action_hash = create_entry(&EntryTypes::ItemReview(review))?;
    create_link(input.item_ref.clone(), action_hash.clone(), LinkTypes::ItemToReview, ())?;
    maybe_write_item_rating_checkpoint(input.item_ref, action_hash.clone(), created_at);
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back item review".into())))
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct ItemRatingSummary {
    pub count: u32,
    pub rating_sum: u32,
}

/// Checkpoint-accelerated, same O(n/K) pattern and same `after`-is->=-not->
/// double-count guard as `get_reputation_summary` -- see that function's
/// doc comment for the full reasoning. `average` is computed by the caller
/// (`rating_sum as f64 / count as f64`, with `count == 0` meaning "no
/// reviews yet") rather than stored, since storing a pre-divided float in
/// an append-only checkpoint would re-introduce float-precision drift
/// across many checkpoints for no benefit over dividing the two integers
/// fresh every read.
#[hdk_extern]
pub fn get_item_rating_summary(item_ref: ActionHash) -> ExternResult<ItemRatingSummary> {
    let checkpoint = latest_checkpoint(item_ref.clone(), LinkTypes::ItemToRatingCheckpoint, |c: &ItemRatingCheckpoint| {
        c.recorded_at
    })?;
    let (mut summary, since, already_counted) = match &checkpoint {
        Some(checkpoint) => (
            ItemRatingSummary { count: checkpoint.count, rating_sum: checkpoint.rating_sum },
            Some(checkpoint.recorded_at),
            Some(checkpoint.related_review.clone()),
        ),
        None => (ItemRatingSummary::default(), None, None),
    };

    fold_since_checkpoint::<ItemReview, _, _>(item_ref, LinkTypes::ItemToReview, since, already_counted, &mut summary, |summary, review| {
        summary.count += 1;
        summary.rating_sum += review.rating as u32;
    })?;
    Ok(summary)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ItemReviewsInput {
    pub item_ref: ActionHash,
    /// Page cursor -- the previous page's `next_before`. `None` starts from
    /// the newest review.
    pub before: Option<Timestamp>,
}

/// A menu item's reviews, newest first (see `get_reviews_for`).
#[hdk_extern]
pub fn get_item_reviews(input: ItemReviewsInput) -> ExternResult<ReviewsPage> {
    review_page(input.item_ref.clone().into(), LinkTypes::ItemToReview, input.before, |record| {
        record.entry().to_app_option::<ItemReview>().ok().flatten().is_some_and(|review| review.item_ref == input.item_ref)
    })
}

#[cfg(feature = "test-utils")]
mod test_utils {
    use hdk::prelude::*;
    use reputation_integrity::LinkTypes;
    relay_coordinator_support::raw_link_test_externs!(StoreToEvent, DriverToEvent, CustomerToEvent, StoreToReputationCheckpoint, DriverToReputationCheckpoint, CustomerToReputationCheckpoint, StoreToReview, DriverToReview, StoreToRatingCheckpoint, DriverToRatingCheckpoint, OrderToReview, ItemToReview, ItemToRatingCheckpoint);
}
