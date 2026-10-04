//! Coordinator zome for reputation: `record_event` (called by a
//! counterparty, never by the subject themselves) and `get_reputation_summary`,
//! a derived, UI-cache-only read -- see the integrity crate's doc comment
//! on why this is never the actual trust source of truth.

use hdk::prelude::*;
use relay_coordinator_support::{fold_since_checkpoint, latest_checkpoint, resolve_latest, should_checkpoint};
use reputation_integrity::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct RecordEventInput {
    pub subject: AgentPubKey,
    pub order_ref: ActionHash,
    pub kind: ReputationEventKind,
}

/// Roughly every this-many events per subject, a `ReputationCheckpoint` is
/// also written -- see `ReputationCheckpoint`'s doc comment (and `ledger`'s
/// identical `CHECKPOINT_INTERVAL`) for why this is O(n/K), not O(1).
const CHECKPOINT_INTERVAL: u64 = 20;

/// Best-effort, same posture as `ledger::maybe_write_checkpoint`: purely a
/// read-side optimization, never required, so a failure here must never
/// fail the event-recording it's piggybacking on. `recorded_at` is
/// deliberately the *event's own* `recorded_at`, not a fresh `sys_time()`
/// call -- see `ledger`'s identical reasoning for why that matters for the
/// `after` boundary in `get_reputation_summary` below.
fn maybe_write_checkpoint(subject: AgentPubKey, event_hash: ActionHash, event_recorded_at: Timestamp) {
    if !should_checkpoint(&event_hash, CHECKPOINT_INTERVAL) {
        return;
    }
    let Ok(summary) = get_reputation_summary(subject.clone()) else { return };
    let checkpoint = ReputationCheckpoint {
        subject: subject.clone(),
        completed_count: summary.completed_count,
        cancelled_by_them_count: summary.cancelled_by_them_count,
        dispute_raised_count: summary.dispute_raised_count,
        dispute_resolved_against_count: summary.dispute_resolved_against_count,
        total_collateral_forfeited: summary.total_collateral_forfeited,
        related_event: event_hash,
        recorded_at: event_recorded_at,
    };
    if let Ok(action_hash) = create_entry(&EntryTypes::ReputationCheckpoint(checkpoint)) {
        let _ = create_link(subject, action_hash, LinkTypes::SubjectToReputationCheckpoint, ());
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
    let event = ReputationEvent {
        subject: input.subject.clone(),
        counterparty,
        order_ref: input.order_ref,
        kind: input.kind,
        recorded_at,
    };
    let action_hash = create_entry(&EntryTypes::ReputationEvent(event))?;
    create_link(input.subject.clone(), action_hash.clone(), LinkTypes::SubjectToEvent, ())?;
    // get_reputation_summary (inside maybe_write_checkpoint) reads via
    // GetStrategy::Local, so it needs this event to already be visible
    // locally -- true here since we just authored it ourselves, in this
    // same call, on our own chain (the counterparty's, not the subject's).
    maybe_write_checkpoint(input.subject, action_hash.clone(), recorded_at);
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
/// since it, instead of this subject's *entire* event history -- O(n/K),
/// not O(1), exactly like `ledger::get_balance` (see that function's doc
/// comment for the full reasoning, and for why `already_counted` below
/// exists: `LinkQuery.after` is `>=`, not strictly-greater).
#[hdk_extern]
pub fn get_reputation_summary(subject: AgentPubKey) -> ExternResult<ReputationSummary> {
    let checkpoint = latest_checkpoint(subject.clone(), LinkTypes::SubjectToReputationCheckpoint, |c: &ReputationCheckpoint| {
        c.recorded_at
    })?;
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

    fold_since_checkpoint::<ReputationEvent, _, _>(
        subject,
        LinkTypes::SubjectToEvent,
        since,
        already_counted,
        &mut summary,
        |summary, event| match event.kind {
            ReputationEventKind::OrderCompleted { .. } => summary.completed_count += 1,
            ReputationEventKind::OrderCancelledByThem => summary.cancelled_by_them_count += 1,
            ReputationEventKind::DisputeRaised => summary.dispute_raised_count += 1,
            ReputationEventKind::DisputeResolvedAgainst => summary.dispute_resolved_against_count += 1,
            ReputationEventKind::CollateralForfeited { amount } => summary.total_collateral_forfeited += amount,
        },
    )?;
    Ok(summary)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SubmitReviewInput {
    pub subject: AgentPubKey,
    pub order_original_action: ActionHash,
    pub rating: u8,
    pub comment: String,
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
#[hdk_extern]
pub fn submit_review(input: SubmitReviewInput) -> ExternResult<Record> {
    if input.rating < 1 || input.rating > 5 {
        return Err(wasm_error!(WasmErrorInner::Guest("rating must be between 1 and 5".into())));
    }
    let order_record = resolve_latest(input.order_original_action)?;
    let author = agent_info()?.agent_initial_pubkey;
    let review = Review {
        subject: input.subject.clone(),
        author,
        order_ref: order_record.action_address().clone(),
        rating: input.rating,
        comment: input.comment,
        created_at: sys_time()?,
    };
    let action_hash = create_entry(&EntryTypes::Review(review))?;
    create_link(input.subject, action_hash.clone(), LinkTypes::SubjectToReview, ())?;
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back review".into())))
}

#[hdk_extern]
pub fn get_reviews_for(subject: AgentPubKey) -> ExternResult<Vec<Record>> {
    let links = get_links(LinkQuery::try_new(subject, LinkTypes::SubjectToReview)?, GetStrategy::default())?;
    let mut reviews = Vec::with_capacity(links.len());
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if let Some(record) = get(action_hash, GetOptions::default())? {
            reviews.push(record);
        }
    }
    Ok(reviews)
}

/// How many `ReputationCheckpoint`s exist for `subject` -- genuinely useful
/// for debugging/monitoring the checkpoint mechanism itself (architecture
/// plan §9.4: is it actually engaging, roughly how often), not just a test
/// hook.
#[hdk_extern]
pub fn count_reputation_checkpoints(subject: AgentPubKey) -> ExternResult<u32> {
    let links = get_links(
        LinkQuery::try_new(subject, LinkTypes::SubjectToReputationCheckpoint)?,
        GetStrategy::Local,
    )?;
    Ok(links.len() as u32)
}

// --- per-item ratings -- same shape as Review/get_reputation_summary
// above, keyed by a MenuItem's action hash instead of an agent pubkey ---

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

#[hdk_extern]
pub fn get_item_reviews(item_ref: ActionHash) -> ExternResult<Vec<Record>> {
    let links = get_links(LinkQuery::try_new(item_ref, LinkTypes::ItemToReview)?, GetStrategy::default())?;
    let mut reviews = Vec::with_capacity(links.len());
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if let Some(record) = get(action_hash, GetOptions::default())? {
            reviews.push(record);
        }
    }
    Ok(reviews)
}
