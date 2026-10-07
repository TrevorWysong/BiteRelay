//! A store's two order queues -- the shape of their links, and who may
//! write them. Modeled on a DoorDash/Uber Eats store tablet:
//!
//! - **Active** (`StoreToActiveOrder`, base = the store's `catalog_ref`):
//!   every order still in progress. Linked when the order is placed and
//!   unlinked when it reaches a terminal status, so reading it costs the
//!   store's *current* workload, never its history. This is the queue a
//!   merchant screen polls.
//! - **History** (`StoreHistoryToOrder`, base = a per-day anchor path under
//!   the store): every order ever placed, permanent. Holochain link queries
//!   filter by time but have no row limit, so one ever-growing link list
//!   would make even "the newest 20" cost the whole history; bucketing by
//!   day means a page only reads the days it covers. The day anchors
//!   themselves (`StoreHistoryPath` links under the store's history root)
//!   double as the index of which days have orders.
//!
//! Both are validated here rather than trusted to the coordinator: anyone
//! can author a link, so without these checks any agent could add junk to
//! (or quietly remove orders from) another store's queue.

use crate::LinkTypes;
use dispatch_types::{DeliveryOrder, PickupOrder};
use hdi::hash_path::path::{Path, TypedPath};
use hdi::prelude::*;

/// The parts of a create- or delete-link op these checks look at. For a
/// delete, `base`/`target` come from the link being deleted and `author` is
/// whoever is deleting it.
pub struct OpLinkFields<'a> {
    pub link_type: &'a LinkTypes,
    pub base: &'a AnyLinkableHash,
    pub target: &'a AnyLinkableHash,
    pub author: &'a AgentPubKey,
}

/// History buckets are UTC days of the order's `requested_at`.
pub const HISTORY_BUCKET_MICROS: i64 = 86_400 * 1_000_000;

pub fn history_day(at: Timestamp) -> i64 {
    at.as_micros().div_euclid(HISTORY_BUCKET_MICROS)
}

/// The store's history root -- its children are the day buckets.
pub fn store_history_root(catalog_ref: &ActionHash) -> ExternResult<TypedPath> {
    Path::from(format!("store_history.{catalog_ref}")).typed(LinkTypes::StoreHistoryPath)
}

pub fn store_history_day(catalog_ref: &ActionHash, day: i64) -> ExternResult<TypedPath> {
    Path::from(format!("store_history.{catalog_ref}.{day}")).typed(LinkTypes::StoreHistoryPath)
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
    let Some(order_ref) = target.clone().into_action_hash() else {
        return Ok(Err("a store queue link must target an order's action hash".into()));
    };
    let record = must_get_valid_record(order_ref)?;
    if let Ok(Some(o)) = record.entry().to_app_option::<DeliveryOrder>() {
        return Ok(Ok(QueuedOrder { requester: o.requester, merchant: o.merchant, catalog_ref: o.catalog_ref, requested_at: o.requested_at }));
    }
    if let Ok(Some(o)) = record.entry().to_app_option::<PickupOrder>() {
        return Ok(Ok(QueuedOrder { requester: o.requester, merchant: o.merchant, catalog_ref: o.catalog_ref, requested_at: o.requested_at }));
    }
    Ok(Err("a store queue link must target a DeliveryOrder or PickupOrder".into()))
}

/// Only the order's own requester (who places it) may enqueue it, and only
/// under the order's own store -- in the right day bucket, for history.
pub fn validate_queue_link_create(link: OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    if !matches!(link.link_type, LinkTypes::StoreHistoryToOrder | LinkTypes::StoreToActiveOrder) {
        return Ok(ValidateCallbackResult::Valid);
    }
    let order = match queued_order(link.target)? {
        Ok(order) => order,
        Err(reason) => return Ok(ValidateCallbackResult::Invalid(reason)),
    };
    if link.author != &order.requester {
        return Ok(ValidateCallbackResult::Invalid("only the order's requester may add it to a store queue".into()));
    }
    let expected_base: AnyLinkableHash = match link.link_type {
        LinkTypes::StoreToActiveOrder => order.catalog_ref.clone().into(),
        _ => store_history_day(&order.catalog_ref, history_day(order.requested_at))?.path_entry_hash()?.into(),
    };
    if link.base != &expected_base {
        return Ok(ValidateCallbackResult::Invalid("a store queue link must sit under the order's own store (and day, for history)".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// History is permanent. An order leaves the active queue only by one of
/// the parties who can end it -- its requester, its merchant, or an
/// arbitrator resolving a dispute.
pub fn validate_queue_link_delete(link: OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    match link.link_type {
        LinkTypes::StoreHistoryToOrder => Ok(ValidateCallbackResult::Invalid("store order history is permanent".into())),
        LinkTypes::StoreToActiveOrder => {
            let order = match queued_order(link.target)? {
                Ok(order) => order,
                Err(reason) => return Ok(ValidateCallbackResult::Invalid(reason)),
            };
            if link.author == &order.requester || link.author == &order.merchant || relay_governance::is_arbitrator(link.author)? {
                Ok(ValidateCallbackResult::Valid)
            } else {
                Ok(ValidateCallbackResult::Invalid("only the order's requester, merchant, or an arbitrator may retire it from the active queue".into()))
            }
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
