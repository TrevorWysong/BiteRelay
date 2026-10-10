//! Every party's view of their orders, and who may write it. Each owner --
//! a store, a customer -- has two queues, modeled on a DoorDash/Uber Eats
//! tablet (stores) and "Orders" tab (customers):
//!
//! - **Active** (`*ToActiveOrder`, base = the owner): every order still in
//!   progress. Linked when the order is placed and unlinked when it reaches
//!   a terminal status, so reading it costs the owner's *current* workload,
//!   never their history. This is what screens poll.
//! - **History** (`*HistoryToOrder`, base = a per-day anchor under the
//!   owner): every order ever placed, permanent. Link queries filter by
//!   time but have no row limit, so day buckets keep a page from touching
//!   the whole history; the day anchors (`*HistoryPath`) double as the
//!   index of which days have orders.
//!
//! A driver has one queue: their active deliveries (`DriverToActiveDelivery`),
//! linked when the customer accepts their bid and unlinked when the
//! delivery ends. Its tag carries the accepted bid's hash, which is what
//! lets validation tie the link to that bidder deterministically.
//!
//! Every link here is validated: without it, anyone could add junk to (or
//! quietly remove orders from) someone else's queues.

use crate::links::OpLinkFields;
use crate::LinkTypes;
use dispatch_types::{Bid, DeliveryOrder, PickupOrder};
use hdi::prelude::*;
use relay_integrity_support::{decode, invalid, linked_record, original_creation, path_hash, require};

/// Whose order queues these are.
pub enum QueueOwner<'a> {
    Store(&'a ActionHash),
    Customer(&'a AgentPubKey),
}

impl QueueOwner<'_> {
    pub fn active_link_type(&self) -> LinkTypes {
        match self {
            QueueOwner::Store(_) => LinkTypes::StoreToActiveOrder,
            QueueOwner::Customer(_) => LinkTypes::CustomerToActiveOrder,
        }
    }

    pub fn active_base(&self) -> AnyLinkableHash {
        match self {
            QueueOwner::Store(catalog_ref) => (*catalog_ref).clone().into(),
            QueueOwner::Customer(agent) => (*agent).clone().into(),
        }
    }

    /// The owner's history root -- its children are the day buckets.
    /// Where the owner's history days are indexed (`history_index_tag`).
    pub fn history_root(&self) -> ExternResult<AnyLinkableHash> {
        let (prefix, _, id) = self.history_parts();
        path_hash(format!("{prefix}.{id}"))
    }

    /// One day of the owner's history, which its orders are linked under.
    pub fn history_day(&self, day: i64) -> ExternResult<AnyLinkableHash> {
        let (prefix, _, id) = self.history_parts();
        path_hash(format!("{prefix}.{id}.{day}"))
    }

    pub fn history_link_type(&self) -> LinkTypes {
        match self {
            QueueOwner::Store(_) => LinkTypes::StoreHistoryToOrder,
            QueueOwner::Customer(_) => LinkTypes::CustomerHistoryToOrder,
        }
    }

    /// The link type indexing the owner's history days.
    pub fn history_index_link_type(&self) -> LinkTypes {
        self.history_parts().1
    }

    fn history_parts(&self) -> (&'static str, LinkTypes, String) {
        match self {
            QueueOwner::Store(catalog_ref) => ("store_history", LinkTypes::StoreHistoryPath, catalog_ref.to_string()),
            QueueOwner::Customer(agent) => ("customer_history", LinkTypes::CustomerHistoryPath, agent.to_string()),
        }
    }
}

/// History buckets are UTC days of the order's `requested_at`.
pub const HISTORY_BUCKET_MICROS: i64 = 86_400 * 1_000_000;

/// The tag of a history index link: the day it indexes, and the order that
/// put an order in it -- what lets validation check every indexed day
/// holds a real order, so nobody can pad a history with empty days.
pub fn history_index_tag(day: i64, order: &ActionHash) -> LinkTag {
    let mut bytes = day.to_be_bytes().to_vec();
    bytes.extend_from_slice(order.get_raw_39());
    LinkTag::new(bytes)
}

/// A history index link's day and order, from its tag.
pub fn parse_history_index_tag(tag: &LinkTag) -> Option<(i64, ActionHash)> {
    let (day, order) = tag.0.split_at_checked(8)?;
    Some((i64::from_be_bytes(day.try_into().ok()?), ActionHash::try_from_raw_39(order.to_vec()).ok()?))
}

pub fn history_day(at: Timestamp) -> i64 {
    at.as_micros().div_euclid(HISTORY_BUCKET_MICROS)
}

/// The creation-time facts queue validation needs, from either order type.
/// All fixed at creation, so the literal record is the right reference.
struct QueuedOrder {
    requester: AgentPubKey,
    merchant: AgentPubKey,
    catalog_ref: ActionHash,
    requested_at: Timestamp,
}

fn queued_order(target: &AnyLinkableHash) -> ExternResult<Result<QueuedOrder, String>> {
    let Some(record) = linked_record(target)? else {
        return Ok(Err("an order queue link must target an order".into()));
    };
    if let Some(o) = decode::<DeliveryOrder>(&record) {
        return Ok(Ok(QueuedOrder { requester: o.requester, merchant: o.merchant, catalog_ref: o.catalog_ref, requested_at: o.requested_at }));
    }
    if let Some(o) = decode::<PickupOrder>(&record) {
        return Ok(Ok(QueuedOrder { requester: o.requester, merchant: o.merchant, catalog_ref: o.catalog_ref, requested_at: o.requested_at }));
    }
    Ok(Err("an order queue link must target a DeliveryOrder or PickupOrder".into()))
}

/// The bid named by a `DriverToActiveDelivery` link's tag.
/// The driver a delivery link's tag names: the bidder of the bid accepted by
/// the order version the tag is -- the version that made them its driver.
fn tagged_driver(tag: &LinkTag, order: &AnyLinkableHash) -> ExternResult<Option<AgentPubKey>> {
    let Ok(version) = ActionHash::try_from_raw_39(tag.0.clone()) else { return Ok(None) };
    if AnyLinkableHash::from(original_creation(version.clone())?) != *order {
        return Ok(None);
    }
    let Some(accepted) = decode::<DeliveryOrder>(&must_get_valid_record(version)?).and_then(|o| o.accepted_bid) else { return Ok(None) };
    Ok(decode::<Bid>(&must_get_valid_record(accepted)?).map(|bid| bid.bidder))
}

/// Only the order's requester (who places it, and accepts a bid) may
/// enqueue it -- under its own store and customer (in the right day bucket,
/// for history), or under the driver whose bid they accepted.
pub fn validate_queue_link_create(link: OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    if matches!(link.link_type, LinkTypes::StoreHistoryPath | LinkTypes::CustomerHistoryPath) {
        return validate_history_index(&link);
    }
    let order = match queued_order(link.target)? {
        Ok(order) => order,
        Err(reason) => return invalid(&reason),
    };
    if link.author != &order.requester {
        return invalid("only the order's requester may add it to an order queue");
    }
    let store = QueueOwner::Store(&order.catalog_ref);
    let customer = QueueOwner::Customer(&order.requester);
    let day = history_day(order.requested_at);
    let expected_base: AnyLinkableHash = match link.link_type {
        LinkTypes::StoreToActiveOrder => store.active_base(),
        LinkTypes::CustomerToActiveOrder => customer.active_base(),
        LinkTypes::StoreHistoryToOrder => store.history_day(day)?,
        LinkTypes::CustomerHistoryToOrder => customer.history_day(day)?,
        LinkTypes::DriverToActiveDelivery => match tagged_driver(link.tag, link.target)? {
            Some(driver) => driver.into(),
            None => return invalid("a driver delivery link's tag must be the order version accepting that driver"),
        },
        _ => return Ok(ValidateCallbackResult::Valid),
    };
    require(link.base == &expected_base, "an order queue link must sit under the order's own store, customer or driver (and day, for history)")
}

/// History is permanent. An order leaves an active queue only by one of the
/// parties who can end it -- its requester or its merchant -- or, for a
/// driver's queue, that driver.
pub fn validate_queue_link_delete(link: OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    match link.link_type {
        LinkTypes::StoreToActiveOrder | LinkTypes::CustomerToActiveOrder | LinkTypes::DriverToActiveDelivery => {
            let order = match queued_order(link.target)? {
                Ok(order) => order,
                Err(reason) => return invalid(&reason),
            };
            let is_driver = matches!(link.link_type, LinkTypes::DriverToActiveDelivery) && tagged_driver(link.tag, link.target)?.as_ref() == Some(link.author);
            require(
                link.author == &order.requester || link.author == &order.merchant || is_driver,
                "only the order's requester, merchant or driver may retire it from an active queue",
            )
        }
        LinkTypes::StoreHistoryToOrder | LinkTypes::StoreHistoryPath | LinkTypes::CustomerHistoryToOrder | LinkTypes::CustomerHistoryPath => {
            invalid("order history is permanent")
        }
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = HISTORY_BUCKET_MICROS;

    #[test]
    fn a_day_bucket_covers_exactly_one_utc_day() {
        assert_eq!(history_day(Timestamp::from_micros(0)), 0);
        assert_eq!(history_day(Timestamp::from_micros(DAY - 1)), 0);
        assert_eq!(history_day(Timestamp::from_micros(DAY)), 1);
        assert_eq!(history_day(Timestamp::from_micros(20_000 * DAY + 12 * 3_600_000_000)), 20_000);
    }

    #[test]
    fn times_before_the_epoch_round_down_not_toward_zero() {
        assert_eq!(history_day(Timestamp::from_micros(-1)), -1);
        assert_eq!(history_day(Timestamp::from_micros(-DAY)), -1);
        assert_eq!(history_day(Timestamp::from_micros(-DAY - 1)), -2);
    }
}

/// A history index link: under the owner's history root, to the day an
/// order of theirs was placed, by its customer, naming the order in its tag
/// (`history_index_tag`).
fn validate_history_index(link: &OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    let Some((day, order_ref)) = parse_history_index_tag(link.tag) else { return invalid("a history index link's tag must name its day and order") };
    let order = match queued_order(&order_ref.into())? {
        Ok(order) => order,
        Err(reason) => return invalid(&reason),
    };
    if link.author != &order.requester || day != history_day(order.requested_at) {
        return invalid("a history day is indexed by its order's customer, for the day it was placed");
    }
    let owner = match link.link_type {
        LinkTypes::StoreHistoryPath => QueueOwner::Store(&order.catalog_ref),
        _ => QueueOwner::Customer(&order.requester),
    };
    require(link.base == &owner.history_root()? && link.target == &owner.history_day(day)?, "a history index link must sit under its own owner's history, pointing at its day")
}
