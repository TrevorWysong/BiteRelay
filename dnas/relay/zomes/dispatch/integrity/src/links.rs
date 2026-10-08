//! Link validation for every dispatch link type: each link must agree with
//! the order or bid it points at, and be authored by the agent who
//! legitimately creates it. The order queues' rules live in `order_queues`.

use super::*;
use crate::order_queues::{validate_queue_link_create, validate_queue_link_delete};
use relay_integrity_support::{decode, invalid, link_target, original_creation, path_hash, require, LinkTarget};

/// The parts of a create- or delete-link op these checks look at. For a
/// delete, `base`/`target` come from the link being deleted and `author` is
/// whoever is deleting it; `timestamp` is the op's own action timestamp.
pub struct OpLinkFields<'a> {
    pub link_type: &'a LinkTypes,
    pub base: &'a AnyLinkableHash,
    pub target: &'a AnyLinkableHash,
    pub tag: &'a LinkTag,
    pub author: &'a AgentPubKey,
    pub timestamp: Timestamp,
}

/// How long an open-order anchor bucket is (architecture plan §9.2):
/// otherwise `open_order_geohash.{geohash}` accumulates one never-deleted
/// link per order, forever, and every discovery read walks the entire
/// history of every order ever placed in that cell. 5 minutes: generous
/// enough that a slow-to-match order doesn't fall out of the *current*
/// bucket before resolving.
pub const OPEN_ORDER_BUCKET_MILLIS: i64 = 300_000;

/// The discovery anchor drivers poll for open orders dropping off in
/// `geohash` that were published during `bucket`.
pub fn open_order_anchor(geohash: &str, bucket: i64) -> String {
    format!("open_order_geohash.{geohash}.{bucket}")
}

pub fn validate_create_link(link: OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    match link.link_type {
        LinkTypes::StoreToActiveOrder
        | LinkTypes::StoreHistoryPath
        | LinkTypes::StoreHistoryToOrder
        | LinkTypes::CustomerToActiveOrder
        | LinkTypes::CustomerHistoryPath
        | LinkTypes::CustomerHistoryToOrder
        | LinkTypes::DriverToActiveDelivery => validate_queue_link_create(link),
        LinkTypes::OrderToBid => {
            let Some(bid) = target_entry::<Bid>(link.target)? else { return invalid("target is not a Bid") };
            require(
                link.author == &bid.bidder && link.base == &AnyLinkableHash::from(original_creation(bid.order_ref)?),
                "a bid may only be linked by its bidder, under its own order's identity",
            )
        }
        LinkTypes::OpenOrderGeohashAnchor => validate_open_order_link(&link),
    }
}

/// Only the order's requester publishes it for discovery, only in its Open
/// form, and only under its own dropoff cell's anchor for when it was
/// published. That time isn't recorded on the entry (a scheduled order is
/// published when it opens), but it's never after this link and at most
/// moments before it, so it falls in this link's bucket or the one before.
fn validate_open_order_link(link: &OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    let record = match link_target(link.target)? {
        LinkTarget::Record(record) => record,
        LinkTarget::PathNode => return Ok(ValidateCallbackResult::Valid),
    };
    let Some(order) = decode::<DeliveryOrder>(&record) else { return invalid("target is not a DeliveryOrder") };
    if link.author != &order.requester || order.status != DeliveryStatus::Open {
        return invalid("only an order's requester may publish it for discovery, and only while it's Open");
    }
    let bucket = relay_types::time_bucket(link.timestamp.as_millis(), OPEN_ORDER_BUCKET_MILLIS);
    let allowed = [bucket, bucket - 1].map(|b| path_hash(open_order_anchor(&order.dropoff_geohash, b)));
    for expected in allowed {
        if link.base == &expected? {
            return Ok(ValidateCallbackResult::Valid);
        }
    }
    invalid("an open order may only be published under its own dropoff cell's current anchor")
}

pub fn validate_delete_link(link: OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    match link.link_type {
        LinkTypes::OpenOrderGeohashAnchor | LinkTypes::OrderToBid => invalid("this dispatch link type can't be deleted"),
        _ => validate_queue_link_delete(link),
    }
}

/// The entry a data link points at, decoded as `T`. `None` for a path node
/// or a different entry type.
fn target_entry<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(target: &AnyLinkableHash) -> ExternResult<Option<T>> {
    Ok(match link_target(target)? {
        LinkTarget::Record(record) => decode::<T>(&record),
        LinkTarget::PathNode => None,
    })
}
