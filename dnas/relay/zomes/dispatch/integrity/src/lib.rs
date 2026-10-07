//! Integrity zome for the delivery order lifecycle: `DeliveryOrder` (with
//! its state-machine transition table, `DeliveryStatus::can_transition_to`)
//! and `Bid` -- see `DeliveryOrder`'s doc comment for why this is a
//! concrete entry type rather than one generalized "Job".

use attestation_types::{Leg, LegKind, ReceiptAttestation};
use catalog_types::{BagClaim, BagClaimFulfillment, MerchantCatalog, PromoCode};
use dispute_types::{Dispute, DisputeOutcome, DisputeStatus};
use hdi::prelude::*;
use relay_types::GeoPoint;

mod bids;
mod delivery;
mod disputes;
mod pickup;
mod recurring;
mod store_queue;
pub use store_queue::{history_day, store_history_day, store_history_root, HISTORY_BUCKET_MICROS};
pub use recurring::{RecurrenceRule, RecurringOrderTemplate};
use bids::{validate_bid_update, validate_new_bid};
use delivery::{validate_new_order, validate_order_transition};
use pickup::{validate_new_pickup_order, validate_pickup_order_transition};
use recurring::{validate_new_recurring_template, validate_recurring_template_update};
use store_queue::{validate_queue_link_create, validate_queue_link_delete, OpLinkFields};

// DeliveryStatus/RequiredAuthor/BidStatus/DeliveryOrder/Bid now live in
// dispatch_types so dispute_integrity can decode a DeliveryOrder too, for
// its own dispute-eligibility validation -- see that crate's doc comment
// for why a direct dependency on this crate wouldn't work. Re-exported here
// so nothing else in this crate or the coordinator crate (which imports via
// `dispatch_integrity::*`) needs to change.
pub use dispatch_types::{Bid, BidStatus, DeliveryOrder, DeliveryStatus, DropoffPreference, PickupOrder, PickupStatus, RequiredAuthor};

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    DeliveryOrder(DeliveryOrder),
    Bid(Bid),
    RecurringOrderTemplate(RecurringOrderTemplate),
    PickupOrder(PickupOrder),
}

#[hdk_link_types]
pub enum LinkTypes {
    RequesterToOrder,
    OpenOrderGeohashAnchor,
    OrderToBid,
    /// `PickupOrder`'s discovery links -- no geohash anchor and no signal
    /// fan-out needed (see `PickupOrder`'s own doc comment: there's no
    /// driver to notify), just the same direct requester/merchant
    /// discoverability `DeliveryOrder` also has via its own two link types.
    RequesterToPickupOrder,
    /// A store's order queues, keyed by the store (its `catalog_ref`), not
    /// the merchant agent -- one owner can run several stores, and each
    /// store has its own queue, the way each DoorDash/Uber Eats location's
    /// tablet only shows that location's orders. Both order types share
    /// them. See `store_queue` for the active/history split.
    StoreToActiveOrder,
    /// Day-bucket anchor path links under a store's history root.
    StoreHistoryPath,
    /// From a store's day bucket to each order placed that day.
    StoreHistoryToOrder,
}

/// An order (or recurring template) names both a `merchant` and the store
/// (`catalog_ref`) it's from -- and every per-store thing downstream (the
/// store's order queue, its reviews, its reputation events) trusts that
/// the two agree. `catalog_ref` is a catalog's original creation action
/// and its `owner` never changes, so the literal record
/// `must_get_valid_record` returns is the correct reference point.
pub(crate) fn check_merchant_owns_catalog(merchant: &AgentPubKey, catalog_ref: &ActionHash) -> ExternResult<Option<String>> {
    let record = must_get_valid_record(catalog_ref.clone())?;
    let Ok(Some(catalog)) = record.entry().to_app_option::<MerchantCatalog>() else {
        return Ok(Some("catalog_ref does not point at a MerchantCatalog entry".into()));
    };
    if &catalog.owner != merchant {
        return Ok(Some("merchant must be the owner of catalog_ref's store".into()));
    }
    Ok(None)
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::DeliveryOrder(order) => validate_new_order(&order, action.author(), action.timestamp()),
            EntryTypes::Bid(bid) => validate_new_bid(&bid, action.author()),
            EntryTypes::RecurringOrderTemplate(template) => validate_new_recurring_template(&template, action.author()),
            EntryTypes::PickupOrder(order) => validate_new_pickup_order(&order, action.author()),
        },
        FlatOp::CreateEntry(OpEntry::UpdateEntry { app_entry, action }) => match app_entry {
            EntryTypes::DeliveryOrder(order) => {
                validate_order_transition(&order, action.author(), &action.original_action_address, action.timestamp())
            }
            EntryTypes::Bid(bid) => validate_bid_update(&bid, action.author()),
            EntryTypes::RecurringOrderTemplate(template) => {
                validate_recurring_template_update(&template, action.author(), &action.original_action_address)
            }
            EntryTypes::PickupOrder(order) => validate_pickup_order_transition(&order, action.author(), &action.original_action_address),
        },
        FlatOp::Link(OpLink::CreateLink { link_type, action }) => validate_queue_link_create(OpLinkFields {
            link_type: &link_type,
            base: &action.base_address,
            target: &action.target_address,
            author: action.author(),
        }),
        FlatOp::Link(OpLink::DeleteLink { link_type, original_action, action }) => validate_queue_link_delete(OpLinkFields {
            link_type: &link_type,
            base: &original_action.base_address,
            target: &original_action.target_address,
            author: action.author(),
        }),
        _ => Ok(ValidateCallbackResult::Valid),
    }
}
