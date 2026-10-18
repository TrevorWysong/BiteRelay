//! Link validation for every dispatch link type: each link must agree with
//! the order or bid it points at, and be authored by the agent who
//! legitimately creates it. The order queues' rules live in `order_queues`.

use super::*;
use crate::order_queues::{validate_queue_link_create, validate_queue_link_delete};
use relay_integrity_support::{decode, invalid, linked_record, original_creation, path_hash, require};

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
        LinkTypes::OrderToIssue | LinkTypes::IssueToResponse | LinkTypes::OrderToDecision | LinkTypes::OrderToCollectRequest | LinkTypes::OrderToDropoffShare => validate_issue_link(&link),
        LinkTypes::DriverToVerification => crate::verification::validate_verification_link(&link),
    }
}

/// An order is published for discovery by whoever opens it -- its store,
/// accepting it, or whoever releases its driver -- only in its Open form,
/// and only under its own dropoff
/// cell's anchor for when it was published. That time isn't recorded on the
/// entry, but it's never after this link and at most moments before it, so
/// it falls in this link's bucket or the one before.
fn validate_open_order_link(link: &OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    // Anchors are computed, never walked: only orders are linked under one.
    let Some(record) = linked_record(link.target)? else { return invalid("an open-order anchor links only orders") };
    let Some(order) = decode::<DeliveryOrder>(&record) else { return invalid("target is not a DeliveryOrder") };
    // Whoever opened this version publishes it: the store accepting the
    // order, or -- after a driver leaves it -- whoever released them (the
    // version's own validation checked they could).
    if link.author != record.action().author() || order.status != DeliveryStatus::Open {
        return invalid("an open order is published by whoever opened that version of it");
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
        LinkTypes::DriverToVerification => {
            let Some(record) = linked_record(link.target)? else { return invalid("target is not a record") };
            require(record.action().author() == link.author, "only its verifier unlinks a verification")
        }
        LinkTypes::OrderToIssue | LinkTypes::IssueToResponse | LinkTypes::OrderToDecision | LinkTypes::OrderToCollectRequest | LinkTypes::OrderToDropoffShare => invalid("an order's issues, requests and settlement are a permanent record"),
        _ => validate_queue_link_delete(link),
    }
}

/// The entry a data link points at, decoded as `T`. `None` for a path node
/// or a different entry type.
fn target_entry<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(target: &AnyLinkableHash) -> ExternResult<Option<T>> {
    Ok(linked_record(target)?.and_then(|record| decode::<T>(&record)))
}

/// An issue, a store's answer, and the store's decisions are each found
/// under the order (or issue) they're about, linked by whoever wrote them.
fn validate_issue_link(link: &OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    use dispatch_types::{IssueResponse, ItemIssue, ItemSettlement, OrderOutcome};
    let Some(record) = linked_record(link.target)? else { return invalid("this link must target a record") };
    let written_by_author = record.action().author() == link.author;
    let expected_base: Option<AnyLinkableHash> = match link.link_type {
        LinkTypes::OrderToIssue => decode::<ItemIssue>(&record).map(|i| i.order.into()),
        LinkTypes::OrderToCollectRequest => decode::<CollectRequest>(&record).map(|r| r.order.into()),
        LinkTypes::OrderToDropoffShare => decode::<DropoffShare>(&record).map(|r| r.order.into()),
        LinkTypes::IssueToResponse => decode::<IssueResponse>(&record).map(|r| r.issue.into()),
        LinkTypes::OrderToDecision => match (decode::<OrderOutcome>(&record), decode::<ItemSettlement>(&record)) {
            (Some(outcome), _) => Some(outcome.order.into()),
            (None, Some(settlement)) => Some(settlement.order.into()),
            _ => None,
        },
        _ => None,
    };
    match expected_base {
        Some(base) => require(written_by_author && &base == link.base, "an issue record is linked under what it's about, by whoever wrote it"),
        None => invalid("this link's target isn't the record its link type indexes"),
    }
}
