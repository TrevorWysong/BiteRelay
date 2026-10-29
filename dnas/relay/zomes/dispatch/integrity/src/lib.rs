//! Integrity zome for the delivery order lifecycle: `DeliveryOrder` (with
//! its state-machine transition table, `DeliveryStatus::can_transition_to`)
//! and `Bid` -- see `DeliveryOrder`'s doc comment for why this is a
//! concrete entry type rather than one generalized "Job".

use attestation_types::{Leg, LegKind, ReceiptAttestation};
use catalog_types::{BagClaim, BagClaimFulfillment, MenuItem, MerchantCatalog, PromoCode};
use hdi::prelude::*;
use relay_integrity_support::{classify, invalid, require, Checked};
use relay_types::GeoPoint;

mod verification;
mod appeals;
mod bids;
mod holds;
mod issues;
mod store_answer;
mod checks;
mod delivery;
mod claims;
mod links;
mod pickup;
mod recurring;
mod order_queues;
mod chain;
use chain::order_types;
use relay_integrity_support::chain::{entries_created, entries_since};
pub use order_queues::{history_day, history_index_tag, parse_history_index_tag, QueueOwner, HISTORY_BUCKET_MICROS};
pub use recurring::{RecurrenceRule, RecurringOrderTemplate, TemplateDetails};
use bids::{validate_bid_update, validate_new_bid};
use delivery::{validate_new_order, validate_order_transition};
use pickup::{validate_new_pickup_order, validate_pickup_order_transition};
use recurring::{validate_new_recurring_template, validate_recurring_template_update};
pub use links::{open_order_anchor, OPEN_ORDER_BUCKET_MILLIS};
use links::{validate_create_link, validate_delete_link, OpLinkFields};

// The entry structs live in dispatch_types so other integrity zomes can
// decode them -- see that crate's doc comment. Re-exported here so the
// coordinator crate imports everything via `dispatch_integrity::*`.
pub use dispatch_types::{Appeal, AppealAnswer, Ruling, DriverVerification, VerificationCheck, lineage, DropoffShare, LinePricer, Chosen, ChosenInput, OrderItem, Selection, SelectionInput, CollectRequest, claimed_value, CarryRefusal, InHand, PinSecret, DROPOFF_GEOHASH_PRECISION, IssueEvidence, IssueKind, IssueLine, IssueResponse, ItemIssue, ItemSettlement, OrderOutcome, Outcome, hold_terms, required_collateral, split_delivery_fee, Bid, BidStatus, Cancellation, DeclineReason, DeliveryOrder, DeliveryStatus, DropoffDetails, DropoffPreference, HoldPurpose, OrderLine, OrderTerms, PickupOrder, PickupStatus, Portion, RequiredAuthor};

// Built once per write and dropped -- boxing the large order would only
// add an allocation.
#[allow(clippy::large_enum_variant)]
#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    DeliveryOrder(DeliveryOrder),
    Bid(Bid),
    RecurringOrderTemplate(RecurringOrderTemplate),
    PickupOrder(PickupOrder),
    ItemIssue(ItemIssue),
    IssueResponse(IssueResponse),
    OrderOutcome(OrderOutcome),
    ItemSettlement(ItemSettlement),
    CollectRequest(CollectRequest),
    DropoffShare(DropoffShare),
    DriverVerification(DriverVerification),
    Appeal(Appeal),
    AppealAnswer(AppealAnswer),
    Ruling(Ruling),
}

#[hdk_link_types]
pub enum LinkTypes {
    /// An entry's update, base = its original, tagged with how deep it is --
    /// how its current version is found in one read
    /// (`relay_integrity_support::versions`). First in every zome.
    Version,
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
    /// Missing and wrong items -- see `dispatch_types::issues`.
    OrderToIssue,
    IssueToResponse,
    /// The store's decisions about an order: its outcome and settlement.
    OrderToDecision,
    /// A customer's request to collect their order, so its store finds it.
    OrderToCollectRequest,
    /// The customer's address shared with a committed driver; tagged with
    /// the driver's key.
    OrderToDropoffShare,
    /// A driver's verifications, linked by their verifiers.
    DriverToVerification,
    /// Appeals of a store's decision -- see `dispatch_types::Appeal`.
    OrderToAppeal,
    ArbiterToAppeal,
    AppealToAnswer,
    AppealToRuling,
    /// The rulings a store's owner pays from their cash-outs.
    StoreOwnerToRuling,
    /// Appeals of a store owner's decisions, so they find them to answer.
    StoreOwnerToAppeal,
    /// A customer's standing orders, base = the customer -- so their own
    /// conductor finds them to fire without reading back through its chain.
    OwnerToTemplate,
}

const _: () = assert!(LinkTypes::Version as u8 == relay_integrity_support::versions::VERSION_LINK_TYPE, "Version must be the first link type");

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
    match classify(op.flattened::<EntryTypes, LinkTypes>()?)? {
        Checked::Create { entry, action } => match entry {
            EntryTypes::DeliveryOrder(order) => validate_new_order(&order, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::Bid(bid) => validate_new_bid(&bid, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::RecurringOrderTemplate(template) => validate_new_recurring_template(&template, action.author()),
            EntryTypes::PickupOrder(order) => validate_new_pickup_order(&order, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::ItemIssue(issue) => issues::validate_item_issue(&issue, action.author(), action.prev_action()),
            EntryTypes::IssueResponse(response) => issues::validate_issue_response(&response, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::OrderOutcome(outcome) => issues::validate_outcome(&outcome, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::ItemSettlement(settlement) => issues::validate_settlement(&settlement, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::CollectRequest(request) => delivery::validate_collect_request(&request, action.author(), action.prev_action()),
            EntryTypes::DropoffShare(share) => delivery::validate_dropoff_share(&share, action.author()),
            EntryTypes::DriverVerification(verification) => verification::validate_verification(&verification, action.author(), action.timestamp()),
            EntryTypes::Appeal(appeal) => appeals::validate_appeal(&appeal, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::AppealAnswer(answer) => appeals::validate_appeal_answer(&answer, action.author(), action.prev_action()),
            EntryTypes::Ruling(ruling) => appeals::validate_ruling(&ruling, action.author(), action.prev_action()),
        },
        Checked::Update { entry, action } => match entry {
            EntryTypes::DeliveryOrder(order) => validate_order_transition(&order, action.author(), &action.original_action_address, action.timestamp(), action.prev_action()),
            EntryTypes::Bid(bid) => validate_bid_update(&bid, action.author(), &action.original_action_address),
            EntryTypes::RecurringOrderTemplate(template) => validate_recurring_template_update(&template, action.author(), &action.original_action_address),
            EntryTypes::PickupOrder(order) => validate_pickup_order_transition(&order, action.author(), &action.original_action_address, action.timestamp()),
            EntryTypes::ItemIssue(_) | EntryTypes::IssueResponse(_) | EntryTypes::OrderOutcome(_) | EntryTypes::ItemSettlement(_) | EntryTypes::CollectRequest(_) | EntryTypes::DropoffShare(_) => {
                Ok(ValidateCallbackResult::Invalid("issues, requests and an order's settlement can't be changed".into()))
            }
            EntryTypes::Appeal(_) | EntryTypes::AppealAnswer(_) | EntryTypes::Ruling(_) => Ok(ValidateCallbackResult::Invalid("an appeal, its answer and its ruling are a permanent record".into())),
            EntryTypes::DriverVerification(_) => {
                Ok(ValidateCallbackResult::Invalid("a verification is renewed with a new one, not changed".into()))
            }
        },
        // Orders, bids and templates move by updates; their history is
        // what payments, reviews and settlements cite.
        // Except a verification, which its verifier may revoke.
        Checked::Delete { action } => verification::validate_verification_delete(&action.data.deletes_address, action.author()),
        Checked::CreateLink { link_type: LinkTypes::Version, action } => relay_integrity_support::versions::validate_version_link(&action.base_address, &action.target_address, &action.tag, action.author()),
        Checked::DeleteLink { link_type: LinkTypes::Version, .. } => Ok(ValidateCallbackResult::Invalid("an entry's versions stay linked".into())),
        Checked::CreateLink { link_type, action } => validate_create_link(OpLinkFields {
            link_type: &link_type,
            base: &action.base_address,
            target: &action.target_address,
            tag: &action.tag,
            author: action.author(),
            timestamp: action.timestamp(),
        }),
        Checked::DeleteLink { link_type, original, action } => validate_delete_link(OpLinkFields {
            link_type: &link_type,
            base: &original.base_address,
            target: &original.target_address,
            tag: &original.tag,
            author: action.author(),
            timestamp: action.timestamp(),
        }),
        Checked::Other => Ok(ValidateCallbackResult::Valid),
    }
}
