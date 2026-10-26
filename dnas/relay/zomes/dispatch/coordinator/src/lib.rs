//! Coordinator zome for the delivery order lifecycle: matching a new order
//! to nearby providers, bidding, and the gated path to completion (payment
//! + reputation). Split by concern rather than kept as one flat file:
//!
//! - `signals` -- the capability grant and local/remote signal wire types
//!   everything else here sends over.
//! - `matching` -- Layers 1/2 of the matching mechanism (plan §3): the
//!   geohash anchor, the cross-zome candidate lookup, the signal fan-out.
//! - `bids` -- placing, withdrawing, and accepting bids.
//! - `orders` -- the order itself: creation, status transitions, and the
//!   gated completion path that settles payment and reputation.
//! - `never_arrived` -- the customer's claim that a delivery never arrived.
//! - `issues` -- missing and wrong items, and the store's decisions: each
//!   order's outcome and its settlement of the food.
//! - `chat` -- direct, signal-only messaging between an order's two active
//!   parties once a bid is accepted. Deliberately not persisted on the DHT
//!   (see that module's own doc comment).
//! - `tracking` -- live driver-location sharing, same signal-only,
//!   not-persisted posture as `chat`, but one-directional (driver ->
//!   requester only).
//! - `parties` -- the "resolve this order's accepted bid" lookup shared by
//!   `chat` and `tracking`, not itself a zome-call surface.
//! - `recurring` -- "same order every Monday" templates, client-fired
//!   (no p2p cron), link-free (local chain query only).
//! - `pickup` -- the pickup vertical's full lifecycle (creation, status,
//!   completion, and a customer's report they can't get it) -- no bid/driver/leg-attestation
//!   concept at all, so unlike delivery this stays one file.
//! - `store_queue` -- each store's active queue and day-bucketed history,
//!   shared by both verticals.

mod accounts;
mod bids;
mod chat;
mod claims;
mod deliveries;
mod issues;
mod lines;
mod matching;
mod never_arrived;
mod order_queues;
mod orders;
mod parties;
mod pin;
mod pickup;
mod pricing;
mod receipts;
mod recurring;
mod settlement;
mod signals;
mod stores;
mod tracking;
mod upkeep;
mod verification;
mod appeals;

pub use bids::*;
pub use chat::*;
pub use deliveries::*;
pub use issues::*;
pub use matching::{get_open_orders_near, rank_bids, RankedBid};
pub use never_arrived::*;
pub use order_queues::*;
pub use orders::*;
pub use pickup::*;
pub use pricing::OrderItem;
pub use recurring::*;
pub use pin::*;
pub use settlement::*;
pub use signals::*;
pub use tracking::*;

#[cfg(feature = "test-utils")]
mod test_utils {
    use hdk::prelude::*;
    use dispatch_integrity::LinkTypes;
    relay_coordinator_support::raw_link_test_externs!(
        OpenOrderGeohashAnchor,
        OrderToBid,
        StoreToActiveOrder,
        StoreHistoryPath,
        StoreHistoryToOrder,
        CustomerToActiveOrder,
        CustomerHistoryPath,
        CustomerHistoryToOrder,
        DriverToActiveDelivery,
        OrderToIssue,
        IssueToResponse,
        OrderToDecision,
        DriverToVerification,
        OrderToAppeal,
        ArbiterToAppeal,
        AppealToAnswer,
        AppealToRuling,
        StoreOwnerToRuling,
        StoreOwnerToAppeal
    );

    #[derive(Serialize, Deserialize, Debug)]
    pub struct RawIssueInput {
        pub order: ActionHash,
        pub lines: Vec<dispatch_integrity::IssueLine>,
        /// The version cited as showing the customer has it -- the order's
        /// latest if left out.
        #[serde(default)]
        pub received: Option<ActionHash>,
    }

    /// An `ItemIssue` as given, with honestly sealed (empty) evidence and
    /// none of the coordinator's checks -- what a modified client could
    /// write -- so a test can prove what validation refuses.
    #[hdk_extern]
    pub fn create_raw_item_issue_for_testing(input: RawIssueInput) -> ExternResult<ActionHash> {
        let evidence = dispatch_integrity::IssueEvidence { note: String::new(), photo_data_uri: String::new() };
        let me = agent_info()?.agent_initial_pubkey;
        let received = match input.received {
            Some(version) => version,
            None => relay_coordinator_support::resolve_latest(input.order.clone())?.action_address().clone(),
        };
        let issue = dispatch_integrity::ItemIssue {
            order: input.order,
            received,
            lines: input.lines,
            sealed_for_store: relay_coordinator_support::seal_chunked(&me, &evidence)?,
        };
        create_entry(&EntryTypes::ItemIssue(issue))
    }

    #[hdk_extern]
    pub fn create_raw_issue_response_for_testing(response: dispatch_integrity::IssueResponse) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::IssueResponse(response))
    }

    /// A store decision as given -- what a modified client could write.
    #[hdk_extern]
    pub fn create_raw_outcome_for_testing(outcome: dispatch_integrity::OrderOutcome) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::OrderOutcome(outcome))
    }

    #[hdk_extern]
    pub fn create_raw_settlement_for_testing(settlement: dispatch_integrity::ItemSettlement) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::ItemSettlement(settlement))
    }

    use dispatch_integrity::{Bid, Cancellation, DeliveryOrder, DeliveryStatus, EntryTypes, PickupOrder, PickupStatus};

    /// Writes a `PickupOrder` exactly as given, skipping the coordinator's
    /// pricing -- what a modified client could do -- so a test can prove
    /// validation refuses a mispriced order on its own. Queued like a real
    /// order, as such a client would, so the store sees it (and signalled,
    /// by `post_commit`).
    #[hdk_extern]
    pub fn create_raw_pickup_order_for_testing(order: PickupOrder) -> ExternResult<Record> {
        let (catalog_ref, requester) = (order.catalog_ref.clone(), order.requester.clone());
        let action_hash = create_entry(&EntryTypes::PickupOrder(order))?;
        crate::order_queues::enqueue(&action_hash, &catalog_ref, &requester, sys_time()?)?;
        get(action_hash, GetOptions::local())?.ok_or(guest("could not read back raw order"))
    }
    use relay_coordinator_support::{guest, resolve_latest_decoded};

    #[derive(Serialize, Deserialize, Debug)]
    pub struct RawDeliveryInput {
        /// One of the caller's orders, placed honestly, to copy.
        pub template: ActionHash,
        #[serde(default)]
        pub catalog_version: Option<ActionHash>,
        #[serde(default)]
        pub dropoff_geohash: Option<String>,
        #[serde(default)]
        pub delivery_subsidy_percent: Option<u8>,
        /// A "sealed" kitchen note of this many bytes -- forged ciphertext,
        /// as only a modified client could write: the conductor won't seal
        /// more than a box holds.
        #[serde(default)]
        pub kitchen_note_bytes: Option<usize>,
    }

    /// A copy of an honest delivery order with the fields given changed --
    /// what a modified client could write -- so a test can prove which
    /// terms validation holds an order to.
    #[hdk_extern]
    pub fn create_raw_delivery_order_for_testing(input: RawDeliveryInput) -> ExternResult<ActionHash> {
        let record = get(input.template, GetOptions::local())?.ok_or(guest("no such order of yours"))?;
        let mut order: DeliveryOrder = record.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("not a delivery order"))?;
        if let Some(version) = input.catalog_version {
            order.catalog_version = version;
        }
        if let Some(geohash) = input.dropoff_geohash {
            order.dropoff_geohash = geohash;
        }
        if let Some(percent) = input.delivery_subsidy_percent {
            order.delivery_subsidy_percent = percent;
        }
        if let Some(bytes) = input.kitchen_note_bytes {
            let real = relay_coordinator_support::seal(&order.merchant, &String::new())?;
            order.kitchen_note = Some(XSalsa20Poly1305EncryptedData::new(*real.as_nonce_ref(), vec![0; bytes]));
        }
        create_entry(&EntryTypes::DeliveryOrder(order))
    }

    #[derive(Serialize, Deserialize, Debug)]
    pub struct ForceOrderUpdateInput {
        pub order_original_action: ActionHash,
        pub next_status: DeliveryStatus,
        pub delivery_receipts: Vec<ActionHash>,
        #[serde(default)]
        pub pickup_proof: Option<ActionHash>,
        #[serde(default)]
        pub cancellation: Option<Cancellation>,
        /// Proof of the time, for the steps that need it.
        #[serde(default)]
        pub beacon: Option<relay_types::Beacon>,
    }

    #[derive(Serialize, Deserialize, Debug)]
    pub struct RawBidUpdateInput {
        pub original_action: ActionHash,
        pub bid: Bid,
    }

    /// Writes a bid exactly as given, past the coordinator's checks -- what
    /// a modified client could -- so a test can prove what validation
    /// refuses.
    #[hdk_extern]
    pub fn create_raw_bid_for_testing(bid: Bid) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::Bid(bid))
    }

    /// Writes a driver verification exactly as given -- what someone off
    /// the verifier roster could try.
    /// Writes a ruling exactly as given -- what someone but the appeal's
    /// arbiter could try.
    #[hdk_extern]
    pub fn create_raw_ruling_for_testing(ruling: dispatch_integrity::Ruling) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::Ruling(ruling))
    }

    #[hdk_extern]
    pub fn create_raw_verification_for_testing(verification: dispatch_integrity::DriverVerification) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::DriverVerification(verification))
    }

    /// Updates a bid with exactly the entry given -- what a modified client
    /// could -- so a test can prove who validation lets change a bid.
    #[hdk_extern]
    pub fn update_raw_bid_for_testing(input: RawBidUpdateInput) -> ExternResult<ActionHash> {
        update_entry(input.original_action, &EntryTypes::Bid(input.bid))
    }

    /// Updates a `DeliveryOrder` with caller-chosen `status`/`delivery_receipts`/
    /// `pickup_proof`/`cancellation`, skipping every check the real externs
    /// make first -- what a peer running its own coordinator could do, since
    /// coordinators aren't part of the DNA. Lets a test prove validation,
    /// not the honest coordinator, enforces the proof gates and field
    /// immutability.
    #[hdk_extern]
    pub fn force_order_update_for_testing(input: ForceOrderUpdateInput) -> ExternResult<Record> {
        let (record, mut order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_original_action.clone(), "DeliveryOrder")?;
        order.status = input.next_status;
        order.beacon = input.beacon;
        order.delivery_receipts = input.delivery_receipts;
        if input.pickup_proof.is_some() {
            order.pickup_proof = input.pickup_proof;
        }
        order.cancellation = input.cancellation;
        let updated = update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;
        get(updated, GetOptions::local())?.ok_or(guest("could not read back forced order update"))
    }

    #[derive(Serialize, Deserialize, Debug)]
    pub struct BranchInput {
        /// The exact version to update -- not necessarily the latest.
        pub version: ActionHash,
        pub next_status: DeliveryStatus,
        #[serde(default)]
        pub cancellation: Option<Cancellation>,
        /// Take the driver off it, as a release does.
        #[serde(default)]
        pub release: bool,
        #[serde(default)]
        pub beacon: Option<relay_types::Beacon>,
    }

    /// Updates one specific version of a delivery -- branching its history,
    /// as two parties writing at once can -- past every check the
    /// coordinator makes, so a test can prove each branch's payments bind.
    #[hdk_extern]
    pub fn branch_order_for_testing(input: BranchInput) -> ExternResult<ActionHash> {
        let record = get(input.version.clone(), GetOptions::default())?.ok_or(guest("no such version"))?;
        let mut order: DeliveryOrder = record.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("not a delivery"))?;
        order.status = input.next_status;
        order.cancellation = input.cancellation;
        if input.release {
            order.accepted_bid = None;
            order.driver_pay_hold = None;
            order.subsidy_hold = None;
            order.collateral_hold = None;
        }
        if input.beacon.is_some() {
            order.beacon = input.beacon;
        }
        update_entry(input.version, &EntryTypes::DeliveryOrder(order))
    }

    #[derive(Serialize, Deserialize, Debug)]
    pub struct RawReleaseInput {
        pub order_original_action: ActionHash,
        #[serde(default)]
        pub beacon: Option<relay_types::Beacon>,
    }

    /// Takes a delivery's driver off it past every check the coordinator
    /// makes (the store's deadlines among them) -- so a test can prove
    /// validation holds whoever writes it to them.
    #[hdk_extern]
    pub fn release_raw_for_testing(input: RawReleaseInput) -> ExternResult<ActionHash> {
        let (record, mut order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_original_action, "DeliveryOrder")?;
        order.accepted_bid = None;
        order.driver_pay_hold = None;
        order.subsidy_hold = None;
        order.collateral_hold = None;
        order.beacon = input.beacon;
        order.status = DeliveryStatus::Open;
        update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order))
    }

    #[derive(Serialize, Deserialize, Debug)]
    pub struct ForcePickupUpdateInput {
        pub order_original_action: ActionHash,
        pub next_status: PickupStatus,
        #[serde(default)]
        pub cancellation: Option<Cancellation>,
        #[serde(default)]
        pub ready_by: Option<Timestamp>,
    }

    /// `force_order_update_for_testing` for a `PickupOrder`: any status,
    /// cancellation and ready time, past every check the real externs make.
    #[hdk_extern]
    pub fn force_pickup_update_for_testing(input: ForcePickupUpdateInput) -> ExternResult<Record> {
        let (record, mut order): (_, PickupOrder) = resolve_latest_decoded(input.order_original_action.clone(), "PickupOrder")?;
        // Accepting cites the customer's food hold, as the real acceptance
        // does -- these tests are about the other rules.
        if order.status == PickupStatus::Placed && input.next_status == PickupStatus::MerchantConfirmed {
            let original = relay_coordinator_support::original_action_of(input.order_original_action)?;
            order.food_hold = crate::settlement::find_hold(&original, &dispatch_integrity::HoldPurpose::Food, &order.requester)?;
        }
        order.status = input.next_status;
        order.cancellation = input.cancellation;
        order.ready_by = input.ready_by;
        let updated = update_entry(record.action_address().clone(), &EntryTypes::PickupOrder(order))?;
        get(updated, GetOptions::local())?.ok_or(guest("could not read back forced pickup update"))
    }
}
