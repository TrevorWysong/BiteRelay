//! Every party's order queues -- see `dispatch_integrity::order_queues` for
//! the model and who may write which link. This module enqueues a new
//! order (its store's and customer's queues), adds an accepted delivery to
//! its driver's, retires an order from every active queue when it ends, and
//! serves the reads each screen needs: active queues (polled) and paginated
//! history (read on demand).

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
pub struct OrderEntry {
    pub kind: OrderKind,
    pub original_action: ActionHash,
    pub record: Record,
}

/// Whose active queues an order sits in.
pub(crate) struct OrderParties {
    pub order_ref: ActionHash,
    pub catalog_ref: ActionHash,
    pub requester: AgentPubKey,
    pub merchant: AgentPubKey,
    /// The accepted driver, for a delivery that has one.
    pub driver: Option<AgentPubKey>,
}

impl OrderParties {
    pub fn delivery(order_ref: &ActionHash, order: &DeliveryOrder) -> ExternResult<Self> {
        let driver = match &order.accepted_bid {
            Some(bid_ref) => resolve_latest(bid_ref.clone())?.entry().to_app_option::<Bid>().map_err(|e| wasm_error!(e))?.map(|bid| bid.bidder),
            None => None,
        };
        Ok(Self { order_ref: order_ref.clone(), catalog_ref: order.catalog_ref.clone(), requester: order.requester.clone(), merchant: order.merchant.clone(), driver })
    }

    pub fn pickup(order_ref: &ActionHash, order: &PickupOrder) -> Self {
        Self { order_ref: order_ref.clone(), catalog_ref: order.catalog_ref.clone(), requester: order.requester.clone(), merchant: order.merchant.clone(), driver: None }
    }
}

/// Called once by the requester, in the same call that creates the order:
/// adds it to its store's and its customer's history (today's bucket) and
/// active queues. `requested_at` must be the order's own `requested_at` --
/// validation re-derives the bucket from it.
pub(crate) fn enqueue(order_ref: &ActionHash, catalog_ref: &ActionHash, requester: &AgentPubKey, requested_at: Timestamp) -> ExternResult<()> {
    let day = history_day(requested_at);
    for owner in [QueueOwner::Store(catalog_ref), QueueOwner::Customer(requester)] {
        let bucket = owner.history_day(day)?;
        bucket.ensure()?;
        create_link(bucket.path_entry_hash()?, order_ref.clone(), owner.history_link_type(), ())?;
        create_link(owner.active_base(), order_ref.clone(), owner.active_link_type(), ())?;
    }
    Ok(())
}

/// Called by the requester when they accept `bid_ref`: the delivery joins
/// its driver's active queue. The tag names the bid, which is what lets
/// validation check the link sits under that bid's own bidder.
pub(crate) fn enqueue_for_driver(order_ref: &ActionHash, bid_ref: &ActionHash, driver: &AgentPubKey) -> ExternResult<()> {
    create_link(driver.clone(), order_ref.clone(), LinkTypes::DriverToActiveDelivery, LinkTag::new(bid_ref.get_raw_39().to_vec()))?;
    Ok(())
}

/// Removes a just-finished order from every active queue it's in. Called by
/// whoever moved it into a terminal status; a queue the caller isn't
/// allowed to edit (see `validate_queue_link_delete`) is skipped rather than
/// failing their whole call. Best-effort beyond that too: a link that
/// hasn't reached this agent yet stays, and the active reads filter by
/// status, so a leftover costs one extra read, never a finished order on
/// screen.
pub(crate) fn retire(order: &OrderParties) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    let is_party = me == order.requester || me == order.merchant || relay_governance::is_arbitrator(&me)?;
    let mut queues: Vec<(AnyLinkableHash, LinkTypes)> = Vec::new();
    if is_party {
        for owner in [QueueOwner::Store(&order.catalog_ref), QueueOwner::Customer(&order.requester)] {
            queues.push((owner.active_base(), owner.active_link_type()));
        }
    }
    if let Some(driver) = &order.driver {
        if is_party || &me == driver {
            queues.push((driver.clone().into(), LinkTypes::DriverToActiveDelivery));
        }
    }
    let target: AnyLinkableHash = order.order_ref.clone().into();
    for (base, link_type) in queues {
        for link in get_links(LinkQuery::try_new(base, link_type)?, GetStrategy::default())? {
            if link.target == target {
                delete_link(link.create_link_hash, GetOptions::default())?;
            }
        }
    }
    Ok(())
}

/// The order's current state as a queue entry, with when it was placed and
/// whether it's still in progress. `None` if the target isn't an order.
fn classify(original_action: ActionHash) -> Option<(OrderEntry, Timestamp, bool)> {
    let record = resolve_latest(original_action.clone()).ok()?;
    let (kind, requested_at, active) = if let Ok(Some(order)) = record.entry().to_app_option::<DeliveryOrder>() {
        (OrderKind::Delivery, order.requested_at, !order.status.is_terminal())
    } else if let Ok(Some(order)) = record.entry().to_app_option::<PickupOrder>() {
        (OrderKind::Pickup, order.requested_at, !order.status.is_terminal())
    } else {
        return None;
    };
    Some((OrderEntry { kind, original_action, record }, requested_at, active))
}

/// An active queue's in-progress orders, oldest first -- the order they get
/// worked through.
fn active_orders(owner: QueueOwner<'_>) -> ExternResult<Vec<OrderEntry>> {
    let links = get_links(LinkQuery::try_new(owner.active_base(), owner.active_link_type())?, GetStrategy::default())?;
    let mut orders: Vec<_> = links.into_iter().filter_map(|l| l.target.into_action_hash()).filter_map(classify).filter(|(_, _, active)| *active).collect();
    orders.sort_by_key(|(_, requested_at, _)| *requested_at);
    Ok(orders.into_iter().map(|(entry, _, _)| entry).collect())
}

const DEFAULT_HISTORY_PAGE: usize = 20;
const MAX_HISTORY_PAGE: usize = 50;
/// The most day buckets one page reads. Anyone can index an empty day
/// under someone's history root (path links can't be tied to an author),
/// so without a cap a page could be made to read any number of them; with
/// it, a page that runs out of days early just hands back a cursor.
const MAX_DAYS_PER_PAGE: usize = 31;

#[derive(Serialize, Deserialize, Debug)]
pub struct OrderHistoryPage {
    pub orders: Vec<OrderEntry>,
    pub next_before: Option<Timestamp>,
}

/// A day bucket's number, from the tag of the path link that indexes it
/// (the tag is the child path component). Read directly rather than via
/// `TypedPath::children_paths`, which calls `ensure()` -- a write -- first.
fn day_from_tag(tag: &LinkTag) -> Option<i64> {
    let component: Component = SerializedBytes::from(UnsafeBytes::from(tag.0.clone())).try_into().ok()?;
    String::try_from(&component).ok()?.parse().ok()
}

/// Every order in `owner`'s history, newest first, a page at a time. Walks
/// day buckets back from the cursor and stops as soon as it has a full
/// page, so a page costs the days it covers, not the whole history.
fn history_page(owner: QueueOwner<'_>, before: Option<Timestamp>, limit: Option<u32>) -> ExternResult<OrderHistoryPage> {
    let limit = limit.map_or(DEFAULT_HISTORY_PAGE, |l| (l as usize).clamp(1, MAX_HISTORY_PAGE));
    let root = owner.history_root()?;
    let mut days: Vec<i64> = get_links(LinkQuery::try_new(root.path_entry_hash()?, owner.history_path_link_type())?, GetStrategy::default())?
        .iter()
        .filter_map(|link| day_from_tag(&link.tag))
        .collect();
    days.sort_unstable_by_key(|day| Reverse(*day));
    days.dedup();
    if let Some(before) = before {
        let cursor_day = history_day(before);
        days.retain(|day| *day <= cursor_day);
    }

    let mut links = Vec::new();
    let mut oldest_day_read = None;
    for &day in days.iter().take(MAX_DAYS_PER_PAGE) {
        let mut query = LinkQuery::try_new(owner.history_day(day)?.path_entry_hash()?, owner.history_link_type())?;
        query.before = before;
        links.extend(get_links(query, GetStrategy::default())?);
        oldest_day_read = Some(day);
        // One more than a page tells us whether another page exists.
        if links.len() > limit {
            break;
        }
    }
    links.sort_by_key(|link| Reverse(link.timestamp));
    // `before` is inclusive (`<=`), so step one microsecond past the last
    // thing included: the page's last order, or -- when the day cap ended
    // the scan short of a full page -- the start of the oldest day read.
    let next_before = if links.len() > limit {
        Some(Timestamp::from_micros(links[limit - 1].timestamp.as_micros() - 1))
    } else {
        oldest_day_read.filter(|_| days.len() > MAX_DAYS_PER_PAGE).map(|day| Timestamp::from_micros(day * HISTORY_BUCKET_MICROS - 1))
    };
    links.truncate(limit);
    let orders = links.into_iter().filter_map(|l| l.target.into_action_hash()).filter_map(classify).map(|(entry, _, _)| entry).collect();
    Ok(OrderHistoryPage { orders, next_before })
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HistoryInput {
    /// Page cursor -- the previous page's `next_before`. `None` starts from
    /// the newest order.
    pub before: Option<Timestamp>,
    /// Page size, 1-50 (default 20).
    pub limit: Option<u32>,
}

// --- stores ---

#[hdk_extern]
pub fn get_active_orders_for_store(catalog_ref: ActionHash) -> ExternResult<Vec<OrderEntry>> {
    active_orders(QueueOwner::Store(&catalog_ref))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct StoreHistoryInput {
    pub catalog_ref: ActionHash,
    pub before: Option<Timestamp>,
    pub limit: Option<u32>,
}

#[hdk_extern]
pub fn get_order_history_for_store(input: StoreHistoryInput) -> ExternResult<OrderHistoryPage> {
    history_page(QueueOwner::Store(&input.catalog_ref), input.before, input.limit)
}

// --- customers (always the caller's own) ---

#[hdk_extern]
pub fn get_my_active_orders(_: ()) -> ExternResult<Vec<OrderEntry>> {
    let me = agent_info()?.agent_initial_pubkey;
    active_orders(QueueOwner::Customer(&me))
}

#[hdk_extern]
pub fn get_my_order_history(input: HistoryInput) -> ExternResult<OrderHistoryPage> {
    let me = agent_info()?.agent_initial_pubkey;
    history_page(QueueOwner::Customer(&me), input.before, input.limit)
}

/// Every order action on the caller's own source chain (creates and
/// updates, both kinds) -- a local read, no network. Only usable for facts
/// the caller's own actions establish.
fn my_order_actions() -> ExternResult<Vec<(OrderKind, Record)>> {
    let mut out = Vec::new();
    for (unit, kind) in [(UnitEntryTypes::DeliveryOrder, OrderKind::Delivery), (UnitEntryTypes::PickupOrder, OrderKind::Pickup)] {
        let filter = ChainQueryFilter::new().entry_type(EntryType::try_from(unit)?).include_entries(true);
        out.extend(query(filter)?.into_iter().map(|record| (kind, record)));
    }
    Ok(out)
}

/// How many of the caller's orders at `catalog_ref` they've completed --
/// what loyalty rewards ("your 6th order is 15% off") count, both kinds.
/// The customer authors completion (`complete_delivery`/`complete_pickup`),
/// so each one is on their own chain: a local count, not a network read of
/// every order they've ever placed. (An order an arbitrator closed in the
/// store's favor isn't counted -- a disputed order shouldn't earn rewards.)
#[hdk_extern]
pub fn count_my_completed_orders(catalog_ref: ActionHash) -> ExternResult<u32> {
    let mut count = 0;
    for (kind, record) in my_order_actions()? {
        if !matches!(record.action().data, ActionData::Update(_)) {
            continue;
        }
        let completed_here = match kind {
            OrderKind::Delivery => record.entry().to_app_option::<DeliveryOrder>().ok().flatten().is_some_and(|o| o.status == DeliveryStatus::Delivered && o.catalog_ref == catalog_ref),
            OrderKind::Pickup => record.entry().to_app_option::<PickupOrder>().ok().flatten().is_some_and(|o| o.status == PickupStatus::PickedUp && o.catalog_ref == catalog_ref),
        };
        if completed_here {
            count += 1;
        }
    }
    Ok(count)
}

/// The order (if any) the caller already placed redeeming `claim_ref` --
/// what lets a confirmed goodie-bag claim be finalized exactly once. Every
/// order is created by its requester, so this is a local chain read.
#[hdk_extern]
pub fn get_my_order_for_claim(claim_ref: ActionHash) -> ExternResult<Option<ActionHash>> {
    for (kind, record) in my_order_actions()? {
        if !matches!(record.action().data, ActionData::Create(_)) {
            continue;
        }
        let claim = match kind {
            OrderKind::Delivery => record.entry().to_app_option::<DeliveryOrder>().ok().flatten().and_then(|o| o.bag_claim_ref),
            OrderKind::Pickup => record.entry().to_app_option::<PickupOrder>().ok().flatten().and_then(|o| o.bag_claim_ref),
        };
        if claim.as_ref() == Some(&claim_ref) {
            return Ok(Some(record.action_address().clone()));
        }
    }
    Ok(None)
}

// --- drivers ---

/// An in-progress delivery, with the accepted bid it's being delivered
/// under (its price and ETA are what a driver's screen shows).
#[derive(Serialize, Deserialize, Debug)]
pub struct ActiveDelivery {
    pub order: OrderEntry,
    pub bid: Record,
}

/// The caller's in-progress deliveries, oldest first. Replaces walking
/// every bid they've ever placed and fetching each order on every poll.
#[hdk_extern]
pub fn get_my_active_deliveries(_: ()) -> ExternResult<Vec<ActiveDelivery>> {
    let me = agent_info()?.agent_initial_pubkey;
    let links = get_links(LinkQuery::try_new(me, LinkTypes::DriverToActiveDelivery)?, GetStrategy::default())?;
    let mut deliveries = Vec::new();
    for link in links {
        let (Some(order_ref), Ok(bid_ref)) = (link.target.into_action_hash(), ActionHash::try_from_raw_39(link.tag.0.clone())) else { continue };
        let Some((order, requested_at, true)) = classify(order_ref) else { continue };
        let Ok(bid) = resolve_latest(bid_ref) else { continue };
        deliveries.push((ActiveDelivery { order, bid }, requested_at));
    }
    deliveries.sort_by_key(|(_, requested_at)| *requested_at);
    Ok(deliveries.into_iter().map(|(d, _)| d).collect())
}
