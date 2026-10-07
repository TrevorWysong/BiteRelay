//! A store's order queues -- see `dispatch_integrity::store_queue` for the
//! active/history model and who may write which link. This module enqueues
//! a new order, retires it from the active queue when it ends, and serves
//! the two reads a merchant screen needs: the active queue (polled) and
//! paginated history (read on demand).

use dispatch_integrity::*;
use hdi::hash_path::path::Component;
use hdk::prelude::*;
use relay_coordinator_support::resolve_latest;
use std::cmp::Reverse;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderKind {
    Delivery,
    Pickup,
}

/// One queue entry, either kind of order. `original_action` is the order's
/// stable identity (what every order extern takes); `record` is its latest
/// state, whose own action hash changes on every status update -- the same
/// split `catalog::CatalogView` makes, for the same reason.
#[derive(Serialize, Deserialize, Debug)]
pub struct StoreOrder {
    pub kind: OrderKind,
    pub original_action: ActionHash,
    pub record: Record,
}

/// The parts of an order its queue links depend on.
pub(crate) struct QueuedOrder<'a> {
    pub order_ref: &'a ActionHash,
    pub catalog_ref: &'a ActionHash,
    pub requester: &'a AgentPubKey,
    pub merchant: &'a AgentPubKey,
}

/// Called once by the requester, in the same call that creates the order:
/// adds it to its store's history (today's bucket) and active queue.
/// `requested_at` must be the order's own `requested_at` -- validation
/// re-derives the bucket from it.
pub(crate) fn enqueue(catalog_ref: &ActionHash, order_ref: &ActionHash, requested_at: Timestamp) -> ExternResult<()> {
    let day = store_history_day(catalog_ref, history_day(requested_at))?;
    day.ensure()?;
    create_link(day.path_entry_hash()?, order_ref.clone(), LinkTypes::StoreHistoryToOrder, ())?;
    create_link(catalog_ref.clone(), order_ref.clone(), LinkTypes::StoreToActiveOrder, ())?;
    Ok(())
}

/// Removes a just-finished order from its store's active queue. Called by
/// whoever moved it into a terminal status; skipped for anyone validation
/// wouldn't allow to (see `validate_queue_link_delete`) rather than failing
/// their whole call. Best-effort beyond that too: if the active link hasn't
/// reached this agent yet, it stays -- the active read filters by status,
/// so a leftover link costs one extra read, never a finished order on screen.
pub(crate) fn retire(order: QueuedOrder<'_>) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    if &me != order.requester && &me != order.merchant && !relay_governance::is_arbitrator(&me)? {
        return Ok(());
    }
    let target: AnyLinkableHash = order.order_ref.clone().into();
    let links = get_links(LinkQuery::try_new(order.catalog_ref.clone(), LinkTypes::StoreToActiveOrder)?, GetStrategy::default())?;
    for link in links.into_iter().filter(|l| l.target == target) {
        delete_link(link.create_link_hash, GetOptions::default())?;
    }
    Ok(())
}

/// The order's current state as a queue entry, with when it was placed and
/// whether it's still in progress. `None` if the target isn't an order.
fn classify(original_action: ActionHash) -> Option<(StoreOrder, Timestamp, bool)> {
    let record = resolve_latest(original_action.clone()).ok()?;
    let (kind, requested_at, active) = if let Ok(Some(order)) = record.entry().to_app_option::<DeliveryOrder>() {
        (OrderKind::Delivery, order.requested_at, !order.status.is_terminal())
    } else if let Ok(Some(order)) = record.entry().to_app_option::<PickupOrder>() {
        (OrderKind::Pickup, order.requested_at, !order.status.is_terminal())
    } else {
        return None;
    };
    Some((StoreOrder { kind, original_action, record }, requested_at, active))
}

fn resolve_orders(links: Vec<Link>) -> Vec<(StoreOrder, Timestamp, bool)> {
    links.into_iter().filter_map(|link| link.target.into_action_hash()).filter_map(classify).collect()
}

/// Every order the store is still working on, oldest first -- the order a
/// kitchen works through them. Bounded by the store's current workload,
/// not its history, so it's cheap enough to poll.
#[hdk_extern]
pub fn get_active_orders_for_store(catalog_ref: ActionHash) -> ExternResult<Vec<StoreOrder>> {
    let links = get_links(LinkQuery::try_new(catalog_ref, LinkTypes::StoreToActiveOrder)?, GetStrategy::default())?;
    let mut orders: Vec<_> = resolve_orders(links).into_iter().filter(|(_, _, active)| *active).collect();
    orders.sort_by_key(|(_, requested_at, _)| *requested_at);
    Ok(orders.into_iter().map(|(order, _, _)| order).collect())
}

const DEFAULT_HISTORY_PAGE: usize = 20;
const MAX_HISTORY_PAGE: usize = 50;

#[derive(Serialize, Deserialize, Debug)]
pub struct OrderHistoryInput {
    pub catalog_ref: ActionHash,
    /// Page cursor -- the previous page's `next_before`. `None` starts from
    /// the newest order.
    pub before: Option<Timestamp>,
    /// Page size, 1-50 (default 20).
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct OrderHistoryPage {
    pub orders: Vec<StoreOrder>,
    pub next_before: Option<Timestamp>,
}

/// A day bucket's number, from the tag of the path link that indexes it
/// (the tag is the child path component). Read directly rather than via
/// `TypedPath::children_paths`, which calls `ensure()` -- a write -- first.
fn day_from_tag(tag: &LinkTag) -> Option<i64> {
    let component: Component = SerializedBytes::from(UnsafeBytes::from(tag.0.clone())).try_into().ok()?;
    String::try_from(&component).ok()?.parse().ok()
}

/// Every order the store has ever received, newest first, one page at a
/// time. Walks day buckets back from the cursor and stops as soon as it has
/// a full page, so a page costs the days it covers, not the whole history.
#[hdk_extern]
pub fn get_order_history_for_store(input: OrderHistoryInput) -> ExternResult<OrderHistoryPage> {
    let limit = input.limit.map_or(DEFAULT_HISTORY_PAGE, |l| (l as usize).clamp(1, MAX_HISTORY_PAGE));
    let root = store_history_root(&input.catalog_ref)?;
    let mut days: Vec<i64> = get_links(LinkQuery::try_new(root.path_entry_hash()?, LinkTypes::StoreHistoryPath)?, GetStrategy::default())?
        .iter()
        .filter_map(|link| day_from_tag(&link.tag))
        .collect();
    days.sort_unstable_by_key(|day| Reverse(*day));
    days.dedup();
    if let Some(before) = input.before {
        let cursor_day = history_day(before);
        days.retain(|day| *day <= cursor_day);
    }

    let mut links = Vec::new();
    for day in days {
        let mut query = LinkQuery::try_new(store_history_day(&input.catalog_ref, day)?.path_entry_hash()?, LinkTypes::StoreHistoryToOrder)?;
        query.before = input.before;
        links.extend(get_links(query, GetStrategy::default())?);
        // One more than a page tells us whether another page exists.
        if links.len() > limit {
            break;
        }
    }
    links.sort_by_key(|link| Reverse(link.timestamp));
    // `before` is inclusive (`<=`), so step one microsecond past the last
    // link included -- same convention as `next_page_cursor`, mirrored.
    let next_before = (links.len() > limit).then(|| Timestamp::from_micros(links[limit - 1].timestamp.as_micros() - 1));
    links.truncate(limit);
    Ok(OrderHistoryPage { orders: resolve_orders(links).into_iter().map(|(order, _, _)| order).collect(), next_before })
}
