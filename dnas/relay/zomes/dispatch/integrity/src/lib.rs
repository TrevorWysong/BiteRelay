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
mod checks;
mod delivery;
mod disputes;
mod links;
mod pickup;
mod recurring;
mod order_queues;
pub use order_queues::{history_day, QueueOwner, HISTORY_BUCKET_MICROS};
pub use recurring::{RecurrenceRule, RecurringOrderTemplate, TemplateDetails};
use bids::{validate_bid_update, validate_new_bid};
use delivery::{validate_new_order, validate_order_transition};
use pickup::{validate_new_pickup_order, validate_pickup_order_transition};
use recurring::{validate_new_recurring_template, validate_recurring_template_update};
pub use links::{open_order_anchor, OPEN_ORDER_BUCKET_MILLIS};
use links::{validate_create_link, validate_delete_link, OpLinkFields};

// DeliveryStatus/RequiredAuthor/BidStatus/DeliveryOrder/Bid now live in
// dispatch_types so dispute_integrity can decode a DeliveryOrder too, for
// its own dispute-eligibility validation -- see that crate's doc comment
// for why a direct dependency on this crate wouldn't work. Re-exported here
// so nothing else in this crate or the coordinator crate (which imports via
// `dispatch_integrity::*`) needs to change.
pub use dispatch_types::{delivery_payments, pickup_payments, split_delivery_fee, Bid, BidStatus, DeliveryOrder, DeliveryStatus, DropoffDetails, DropoffPreference, LegPayment, OrderLine, PaymentLeg, PickupOrder, PickupStatus, RequiredAuthor};

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
    OpenOrderGeohashAnchor,
    OrderToBid,
    /// `PickupOrder`'s discovery links -- no geohash anchor and no signal
    /// fan-out needed (see `PickupOrder`'s own doc comment: there's no
    /// driver to notify), just the same direct requester/merchant
    /// discoverability `DeliveryOrder` also has via its own two link types.
    /// Order queues -- see `order_queues` for the model. A store's are
    /// keyed by the store (its `catalog_ref`), not the merchant agent: one
    /// owner can run several stores, each with its own queue. Both order
    /// types share every queue.
    StoreToActiveOrder,
    StoreHistoryPath,
    StoreHistoryToOrder,
    CustomerToActiveOrder,
    CustomerHistoryPath,
    CustomerHistoryToOrder,
    /// A driver's in-progress deliveries; the tag is the accepted bid.
    DriverToActiveDelivery,
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
            EntryTypes::DeliveryOrder(order) => validate_new_order(&order, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::Bid(bid) => validate_new_bid(&bid, action.author()),
            EntryTypes::RecurringOrderTemplate(template) => validate_new_recurring_template(&template, action.author()),
            EntryTypes::PickupOrder(order) => validate_new_pickup_order(&order, action.author(), action.timestamp(), action.prev_action()),
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
        FlatOp::Link(OpLink::CreateLink { link_type, action }) => validate_create_link(OpLinkFields {
            link_type: &link_type,
            base: &action.base_address,
            target: &action.target_address,
            tag: &action.tag,
            author: action.author(),
            timestamp: action.timestamp(),
        }),
        FlatOp::Link(OpLink::DeleteLink { link_type, original_action, action }) => validate_delete_link(OpLinkFields {
            link_type: &link_type,
            base: &original_action.base_address,
            target: &original_action.target_address,
            tag: &original_action.tag,
            author: action.author(),
            timestamp: action.timestamp(),
        }),
        _ => Ok(ValidateCallbackResult::Valid),
    }
}
