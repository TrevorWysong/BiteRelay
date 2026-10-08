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
//! - `disputes` -- raising a dispute and applying an arbitrator's
//!   resolution (plan §8).
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
//!   completion, and its own dispute path) -- no bid/driver/leg-attestation
//!   concept at all, so unlike delivery this stays one file.
//! - `store_queue` -- each store's active queue and day-bucketed history,
//!   shared by both verticals.

mod bids;
mod chat;
mod disputes;
mod matching;
mod order_queues;
mod orders;
mod parties;
mod pickup;
mod pricing;
mod recurring;
mod settlement;
mod signals;
mod tracking;

pub use bids::*;
pub use chat::*;
pub use disputes::*;
pub use matching::get_open_orders_near;
pub use order_queues::*;
pub use orders::*;
pub use pickup::*;
pub use pricing::OrderItemInput;
pub use recurring::*;
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
        DriverToActiveDelivery
    );

    use dispatch_integrity::{DeliveryOrder, DeliveryStatus, EntryTypes, PickupOrder};

    /// Writes a `PickupOrder` exactly as given, skipping the coordinator's
    /// pricing -- what a modified client could do -- so a test can prove
    /// validation refuses a mispriced order on its own.
    #[hdk_extern]
    pub fn create_raw_pickup_order_for_testing(order: PickupOrder) -> ExternResult<Record> {
        let action_hash = create_entry(&EntryTypes::PickupOrder(order))?;
        get(action_hash, GetOptions::local())?.ok_or(wasm_error!(WasmErrorInner::Guest("could not read back raw order".into())))
    }
    use relay_coordinator_support::resolve_latest_decoded;

    #[derive(Serialize, Deserialize, Debug)]
    pub struct ForceOrderUpdateInput {
        pub order_original_action: ActionHash,
        pub next_status: DeliveryStatus,
        pub delivery_receipts: Vec<ActionHash>,
        #[serde(default)]
        pub dispute_ref: Option<ActionHash>,
    }

    /// Updates a `DeliveryOrder` with caller-chosen `status`/`delivery_receipts`/
    /// `dispute_ref`, skipping every check the real externs make first --
    /// what a peer running its own coordinator could do, since coordinators
    /// aren't part of the DNA. Lets a test prove validation, not the honest
    /// coordinator, enforces the completion gate, dispute gate and field
    /// immutability.
    #[hdk_extern]
    pub fn force_order_update_for_testing(input: ForceOrderUpdateInput) -> ExternResult<Record> {
        let (record, mut order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_original_action, "DeliveryOrder")?;
        order.status = input.next_status;
        order.delivery_receipts = input.delivery_receipts;
        order.dispute_ref = input.dispute_ref;
        let updated = update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;
        get(updated, GetOptions::local())?.ok_or(wasm_error!(WasmErrorInner::Guest("could not read back forced order update".into())))
    }
}
