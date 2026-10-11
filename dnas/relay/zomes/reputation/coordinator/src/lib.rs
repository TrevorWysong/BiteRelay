//! Coordinator zome for reputation: `record_event` (called by a
//! counterparty, never by the subject themselves) and `get_reputation_summary`,
//! a derived, UI-cache-only read -- see the integrity crate's doc comment
//! on why this is never the actual trust source of truth -- plus store,
//! driver and menu-item reviews and their ratings.
//!
//! Every summary is summed from link tags that validation checks against
//! the entry each link points at (`review_tag`/`event_tag`), counting one
//! vote per author per order -- never from a summary someone else wrote,
//! which nobody can check is complete.
//!
//! Every read and write is keyed by a scoped target (`ReputationTarget`/
//! `ReviewTarget`), never a bare agent -- see the integrity crate's module
//! doc comment for why.

use hdk::prelude::*;
use relay_coordinator_support::{original_action_of, resolve_latest};
use std::collections::BTreeMap;
use reputation_integrity::*;

/// Where a `ReputationTarget`'s events live: the link base and type.
fn event_links(target: &ReputationTarget) -> (AnyLinkableHash, LinkTypes) {
    match target {
        ReputationTarget::Store(catalog_ref) => (catalog_ref.clone().into(), LinkTypes::StoreToEvent),
        ReputationTarget::Driver(agent) => (agent.clone().into(), LinkTypes::DriverToEvent),
        ReputationTarget::Customer(agent) => (agent.clone().into(), LinkTypes::CustomerToEvent),
    }
}

/// Where a `ReviewTarget`'s reviews live.
fn review_links(target: &ReviewTarget) -> (AnyLinkableHash, LinkTypes) {
    match target {
        ReviewTarget::Store(catalog_ref) => (catalog_ref.clone().into(), LinkTypes::StoreToReview),
        ReviewTarget::Driver(agent) => (agent.clone().into(), LinkTypes::DriverToReview),
    }
}

/// Each rating under `base`, one per author per order: a customer who
/// (with a modified client) reviewed the same order twice still counts
/// once. Read from the links' validated tags alone -- one network read,
/// however many reviews there are.
fn ratings(base: AnyLinkableHash, link_type: LinkTypes) -> ExternResult<Vec<u8>> {
    let mut votes: BTreeMap<(AgentPubKey, Vec<u8>), u8> = BTreeMap::new();
    for link in get_links(LinkQuery::try_new(base, link_type)?, GetStrategy::default())? {
        let tag = link.tag.into_inner();
        let (Some(&rating), Some(order)) = (tag.first(), tag.get(1..)) else { continue };
        if (1..=5).contains(&rating) {
            votes.entry((link.author, order.to_vec())).or_insert(rating);
        }
    }
    Ok(votes.into_values().collect())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RecordEventInput {
    pub target: ReputationTarget,
    pub order_ref: ActionHash,
    pub kind: ReputationEventKind,
    /// What the event rests on: the order's version it records, or its
    /// store's decision (see `reputation_integrity::validate_event`).
    pub basis: ActionHash,
}

/// Called by the counterparty after a completed/cancelled/disputed order --
/// typically invoked cross-zome from `attestation` or `dispatch` once a
/// receipt or cancellation is finalized, rather than called directly by a
/// client.
#[hdk_extern]
pub fn record_event(input: RecordEventInput) -> ExternResult<Record> {
    let counterparty = agent_info()?.agent_initial_pubkey;
    let (base, event_link) = event_links(&input.target);
    let tag = event_tag(&input.kind, &input.order_ref);
    let event = ReputationEvent { target: input.target, counterparty, order_ref: input.order_ref, basis: input.basis, kind: input.kind, recorded_at: sys_time()? };
    let action_hash = create_entry(&EntryTypes::ReputationEvent(event))?;
    create_link(base, action_hash.clone(), event_link, tag)?;
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back reputation event".into())))
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct ReputationSummary {
    pub completed_count: u32,
    pub cancelled_by_them_count: u32,
    pub dispute_raised_count: u32,
    pub dispute_resolved_against_count: u32,
    /// Deliveries the driver left before picking them up.
    pub dropped_count: u32,
    /// Times a store kept a checked-in driver waiting past the network's wait.
    pub late_count: u32,
    /// Offers a driver let lapse, or turned down, without committing.
    pub lapsed_count: u32,
    /// Drivers' reports that a store wouldn't check them in -- from drivers
    /// who've delivered for enough different stores (`min_reporter_stores`).
    pub check_in_refused_count: u32,
    pub total_collateral_forfeited: u64,
}

/// A UI-display cache only -- see the integrity crate's doc comment. Do not
/// use this alone to decide whether to accept a bid; check the agent's real
/// activity chain and any outstanding warrants first. Each kind of event
/// counts once per recorder per order.
/// `event_tag`'s code for a driver's report that a store wouldn't check them
/// in.
const CHECK_IN_REFUSED: u8 = 7;
/// `event_tag`'s code for a completed order.
const COMPLETED: u8 = 0;

/// How many different stores have recorded a completed delivery by
/// `driver` -- each store records its own, so each is a different agent.
fn stores_delivered_for(driver: &AgentPubKey) -> ExternResult<u32> {
    let (base, event_link) = event_links(&ReputationTarget::Driver(driver.clone()));
    let mut stores: Vec<AgentPubKey> = Vec::new();
    for link in get_links(LinkQuery::try_new(base, event_link)?, GetStrategy::default())? {
        if link.tag.0.first() == Some(&COMPLETED) && !stores.contains(&link.author) {
            stores.push(link.author);
        }
    }
    Ok(stores.len() as u32)
}

#[hdk_extern]
pub fn get_reputation_summary(target: ReputationTarget) -> ExternResult<ReputationSummary> {
    let (base, event_link) = event_links(&target);
    // Each order counts once per kind of event, whoever recorded it: two of
    // an order's parties can each record the same fact (a cancellation), and
    // it's still one fact.
    let mut events: BTreeMap<(u8, Vec<u8>), u64> = BTreeMap::new();
    // A driver's report that a store wouldn't check them in counts only if
    // they've completed enough deliveries -- a throwaway identity's reports
    // don't. Each reporter is looked up once.
    let mut seasoned: BTreeMap<AgentPubKey, bool> = BTreeMap::new();
    for link in get_links(LinkQuery::try_new(base, event_link)?, GetStrategy::default())? {
        let tag = link.tag.into_inner();
        if tag.len() != 1 + 8 + 39 {
            continue;
        }
        if tag[0] == CHECK_IN_REFUSED {
            let reporter = link.author.clone();
            let counts = match seasoned.get(&reporter) {
                Some(counts) => *counts,
                None => {
                    let counts = stores_delivered_for(&reporter)? >= relay_governance::min_reporter_stores();
                    seasoned.insert(reporter, counts);
                    counts
                }
            };
            if !counts {
                continue;
            }
        }
        let amount = u64::from_be_bytes(tag[1..9].try_into().expect("checked length"));
        events.entry((tag[0], tag[9..].to_vec())).or_insert(amount);
    }
    let mut summary = ReputationSummary::default();
    for ((code, _), amount) in events {
        match code {
            0 => summary.completed_count += 1,
            1 => summary.cancelled_by_them_count += 1,
            2 => summary.dispute_raised_count += 1,
            3 => summary.dispute_resolved_against_count += 1,
            5 => summary.dropped_count += 1,
            6 => summary.late_count += 1,
            8 => summary.lapsed_count += 1,
            CHECK_IN_REFUSED => summary.check_in_refused_count += 1,
            4 => summary.total_collateral_forfeited += amount,
            _ => {}
        }
    }
    Ok(summary)
}

// --- store/driver reviews ---

#[derive(Serialize, Deserialize, Debug)]
pub struct SubmitReviewInput {
    pub target: ReviewTarget,
    pub order_original_action: ActionHash,
    pub rating: u8,
    pub comment: String,
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
/// which exist yet on the as-created record. This coordinator's own status
/// check is a fast-fail
/// convenience; `validate_review` is what actually enforces it.
///
/// One review per target per order, same as DoorDash/Uber Eats --
/// validation walks the author's chain for an earlier one
/// (`reputation_integrity::validate_review`); checked here first to say so.
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
    let (base, review_link) = review_links(&input.target);
    create_link(base, action_hash.clone(), review_link, review_tag(input.rating, &input.order_original_action))?;
    create_link(input.order_original_action, action_hash.clone(), LinkTypes::OrderToReview, ())?;
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
    let (base, review_link) = review_links(&input.target);
    review_page(base, review_link, input.before, |record| {
        record.entry().to_app_option::<Review>().ok().flatten().is_some_and(|review| review.target == input.target)
    })
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct RatingSummary {
    pub count: u32,
    pub rating_sum: u32,
}

/// The star rating shown on a store card/page or a driver's bid.
#[hdk_extern]
pub fn get_rating_summary(target: ReviewTarget) -> ExternResult<RatingSummary> {
    let (base, review_link) = review_links(&target);
    let ratings = ratings(base, review_link)?;
    Ok(RatingSummary { count: ratings.len() as u32, rating_sum: ratings.iter().map(|&r| r as u32).sum() })
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

/// Same `resolve_latest`-before-writing treatment as `submit_review`'s own
/// doc comment explains -- `validate_item_review` needs to deterministically
/// see the order's real `Delivered` status and final `item_refs`.
#[hdk_extern]
pub fn submit_item_review(input: SubmitItemReviewInput) -> ExternResult<Record> {
    if input.rating < 1 || input.rating > 5 {
        return Err(wasm_error!(WasmErrorInner::Guest("rating must be between 1 and 5".into())));
    }
    // Once per item per order -- validation's rule, told first.
    let mine = query(ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::ItemReview)?).include_entries(true))?;
    let reviewed = mine.iter().filter_map(|r| r.entry().to_app_option::<ItemReview>().ok().flatten()).any(|earlier| {
        earlier.item_ref == input.item_ref && original_action_of(earlier.order_ref).is_ok_and(|order| order == input.order_original_action)
    });
    if reviewed {
        return Err(wasm_error!(WasmErrorInner::Guest("You've already rated this item from this order.".into())));
    }
    let order_record = resolve_latest(input.order_original_action.clone())?;
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
    create_link(input.item_ref, action_hash.clone(), LinkTypes::ItemToReview, review_tag(input.rating, &input.order_original_action))?;
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back item review".into())))
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct ItemRatingSummary {
    pub count: u32,
    pub rating_sum: u32,
}

/// A menu item's rating. `average` is the caller's to compute
/// (`rating_sum / count`; `count == 0` means no reviews yet).
#[hdk_extern]
pub fn get_item_rating_summary(item_ref: ActionHash) -> ExternResult<ItemRatingSummary> {
    let ratings = ratings(item_ref.into(), LinkTypes::ItemToReview)?;
    Ok(ItemRatingSummary { count: ratings.len() as u32, rating_sum: ratings.iter().map(|&r| r as u32).sum() })
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
    use reputation_integrity::{EntryTypes, LinkTypes, Review};
    relay_coordinator_support::raw_link_test_externs!(StoreToEvent, DriverToEvent, CustomerToEvent, StoreToReview, DriverToReview, OrderToReview, ItemToReview);

    /// Writes a review exactly as given, past the coordinator's checks --
    /// what a modified client could -- so a test can prove what validation
    /// refuses.
    #[hdk_extern]
    pub fn create_raw_review_for_testing(review: Review) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::Review(review))
    }
}
