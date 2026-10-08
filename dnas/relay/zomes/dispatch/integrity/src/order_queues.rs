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
use hdi::hash_path::path::{Path, TypedPath};
use hdi::prelude::*;
use relay_integrity_support::{decode, invalid, link_target, original_creation, require, LinkTarget};

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
    pub fn history_root(&self) -> ExternResult<TypedPath> {
        let (prefix, path_type, id) = self.history_parts();
        Path::from(format!("{prefix}.{id}")).typed(path_type)
    }

    pub fn history_day(&self, day: i64) -> ExternResult<TypedPath> {
        let (prefix, path_type, id) = self.history_parts();
        Path::from(format!("{prefix}.{id}.{day}")).typed(path_type)
    }

    pub fn history_link_type(&self) -> LinkTypes {
        match self {
            QueueOwner::Store(_) => LinkTypes::StoreHistoryToOrder,
            QueueOwner::Customer(_) => LinkTypes::CustomerHistoryToOrder,
        }
    }

    /// The link type of the owner's day-bucket path links.
    pub fn history_path_link_type(&self) -> LinkTypes {
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
    let LinkTarget::Record(record) = link_target(target)? else {
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
fn tagged_bid(tag: &LinkTag) -> ExternResult<Option<Bid>> {
    let Ok(bid_ref) = ActionHash::try_from_raw_39(tag.0.clone()) else { return Ok(None) };
    Ok(decode::<Bid>(&must_get_valid_record(bid_ref)?))
}

/// Only the order's requester (who places it, and accepts a bid) may
/// enqueue it -- under its own store and customer (in the right day bucket,
/// for history), or under the driver whose bid they accepted.
pub fn validate_queue_link_create(link: OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    if matches!(link.link_type, LinkTypes::StoreHistoryPath | LinkTypes::CustomerHistoryPath) {
        return require(matches!(link_target(link.target)?, LinkTarget::PathNode), "history path links must target a path");
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
        LinkTypes::StoreHistoryToOrder => store.history_day(day)?.path_entry_hash()?.into(),
        LinkTypes::CustomerHistoryToOrder => customer.history_day(day)?.path_entry_hash()?.into(),
        LinkTypes::DriverToActiveDelivery => {
            let Some(bid) = tagged_bid(link.tag)? else { return invalid("a driver delivery link's tag must name the accepted bid") };
            // A scheduled order is bid on via the update that opened it
            // (that's the version published to drivers), so compare
            // identities, not the exact version the bid names.
            if AnyLinkableHash::from(original_creation(bid.order_ref)?) != *link.target {
                return invalid("the tagged bid must be for this order");
            }
            bid.bidder.into()
        }
        _ => return Ok(ValidateCallbackResult::Valid),
    };
    require(link.base == &expected_base, "an order queue link must sit under the order's own store, customer or driver (and day, for history)")
}

/// History is permanent. An order leaves an active queue only by one of the
/// parties who can end it -- its requester, its merchant, or an arbitrator
/// resolving a dispute -- or, for a driver's queue, that driver.
pub fn validate_queue_link_delete(link: OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    match link.link_type {
        LinkTypes::StoreToActiveOrder | LinkTypes::CustomerToActiveOrder | LinkTypes::DriverToActiveDelivery => {
            let order = match queued_order(link.target)? {
                Ok(order) => order,
                Err(reason) => return invalid(&reason),
            };
            let is_driver = matches!(link.link_type, LinkTypes::DriverToActiveDelivery) && tagged_bid(link.tag)?.is_some_and(|bid| &bid.bidder == link.author);
            require(
                link.author == &order.requester || link.author == &order.merchant || is_driver || relay_governance::is_arbitrator(link.author)?,
                "only the order's requester, merchant, driver or an arbitrator may retire it from an active queue",
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
