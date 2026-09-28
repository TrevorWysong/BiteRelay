//! The delivery order lifecycle: creating one (which kicks off matching),
//! advancing its status through prep/pickup, and the gated completion path
//! that actually settles payment and reputation. See `bids.rs` for the
//! bidding steps in between, and `matching.rs`/`signals.rs` for how a new
//! order actually reaches nearby providers.

use crate::matching::{geo_presence_precision, notify_nearby_providers, open_order_anchor_path, OPEN_ORDER_BUCKET_MILLIS};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::resolve_latest;
use relay_types::GeoPoint;

#[derive(Serialize, Deserialize, Debug)]
pub struct RequestDeliveryInput {
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    pub item_refs: Vec<ActionHash>,
    pub order_total: u64,
    pub dropoff: GeoPoint,
    pub max_delivery_fee: Option<u64>,
    #[serde(default)]
    pub special_instructions: String,
    #[serde(default)]
    pub tip_cents: u64,
}

#[hdk_extern]
pub fn request_delivery(input: RequestDeliveryInput) -> ExternResult<Record> {
    let requester = agent_info()?.agent_initial_pubkey;
    let merchant = input.merchant.clone();
    let now = sys_time()?;
    let dropoff_geohash = relay_types::encode(input.dropoff, geo_presence_precision());
    let order = DeliveryOrder {
        requester: requester.clone(),
        merchant: input.merchant,
        catalog_ref: input.catalog_ref,
        item_refs: input.item_refs,
        order_total: input.order_total,
        dropoff: input.dropoff,
        dropoff_geohash: dropoff_geohash.clone(),
        max_delivery_fee: input.max_delivery_fee,
        status: DeliveryStatus::Open,
        accepted_bid: None,
        delivery_receipts: Vec::new(),
        dispute_ref: None,
        requested_at: now,
        special_instructions: input.special_instructions,
        tip_cents: input.tip_cents,
    };
    let action_hash = create_entry(&EntryTypes::DeliveryOrder(order))?;
    create_link(requester, action_hash.clone(), LinkTypes::RequesterToOrder, ())?;
    // The merchant is never in `notify_nearby_providers`'s signal audience
    // below (that's providers only) and has no anchor of their own to poll
    // -- without this link a merchant has no way to discover an order
    // naming them at all, not even a delayed one. Mirrors RequesterToOrder.
    create_link(merchant, action_hash.clone(), LinkTypes::MerchantToOrder, ())?;

    let bucket = relay_types::time_bucket(now.as_millis(), OPEN_ORDER_BUCKET_MILLIS);
    let path = open_order_anchor_path(&dropoff_geohash, bucket)?;
    path.ensure()?;
    create_link(path.path_entry_hash()?, action_hash.clone(), LinkTypes::OpenOrderGeohashAnchor, ())?;

    // Best-effort fast path. A driver who missed this falls back to polling
    // get_open_orders_near -- see plan §3's named "signals can silently drop" risk.
    let _ = notify_nearby_providers(&action_hash, &dropoff_geohash);

    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back delivery order".into())))
}

/// Reads a specific, already-known order's current state -- every other
/// order-bearing extern here returns the order it just touched, but nothing
/// previously let a client re-fetch a *given* order later (a page reload, a
/// third party checking status the requester's own mutations wouldn't
/// surface, a driver polling their own accepted order). `resolve_latest`
/// is what makes this reflect the order's real current status rather than
/// its original `Open` creation record -- see the `get()`-on-`ActionHash`
/// literalness note in `HOLOCHAIN_ISSUES.md` #4.
#[hdk_extern]
pub fn get_order(order_original_action: ActionHash) -> ExternResult<Record> {
    resolve_latest(order_original_action)
}

/// The requester's own `RequesterToOrder` links -- always creatable from a
/// purely local read for the requester's own base, since they authored
/// every one of these links themselves.
#[hdk_extern]
pub fn get_orders_for_requester(requester: AgentPubKey) -> ExternResult<Vec<Record>> {
    let links = get_links(LinkQuery::try_new(requester, LinkTypes::RequesterToOrder)?, GetStrategy::default())?;
    let mut orders = Vec::with_capacity(links.len());
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if let Ok(record) = resolve_latest(action_hash) {
            orders.push(record);
        }
    }
    Ok(orders)
}

/// The `MerchantToOrder` counterpart -- unlike the requester's own read
/// above, these links were authored by *other* agents (each order's
/// requester), so this genuinely depends on gossip having propagated them
/// to whatever authority holds basis for the merchant's own pubkey.
#[hdk_extern]
pub fn get_orders_for_merchant(merchant: AgentPubKey) -> ExternResult<Vec<Record>> {
    let links = get_links(LinkQuery::try_new(merchant, LinkTypes::MerchantToOrder)?, GetStrategy::default())?;
    let mut orders = Vec::with_capacity(links.len());
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if let Ok(record) = resolve_latest(action_hash) {
            orders.push(record);
        }
    }
    Ok(orders)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetOrderStatusInput {
    pub order_original_action: ActionHash,
    pub next_status: DeliveryStatus,
}

/// Covers every other forward transition in the order lifecycle (merchant
/// confirming prep, driver picking up, cancellation) -- the integrity zome's
/// `can_transition_to` table is what actually enforces which transitions
/// are legal, so this stays a thin wrapper. Delivered is deliberately
/// excluded -- see `complete_delivery`, which is the gated path for that
/// specific transition and additionally requires proof of both handoffs.
#[hdk_extern]
pub fn set_order_status(input: SetOrderStatusInput) -> ExternResult<Record> {
    if input.next_status == DeliveryStatus::Delivered {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "use complete_delivery to mark an order Delivered -- it verifies leg attestations first".into()
        )));
    }
    let record = resolve_latest(input.order_original_action)?;
    let mut order: DeliveryOrder = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a DeliveryOrder".into())))?;
    order.status = input.next_status;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back updated order".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CompleteDeliveryInput {
    pub order_original_action: ActionHash,
}

// Wire-compatible mirrors of ledger's and reputation's input/enum shapes --
// coordinator zomes call each other over the zome-call boundary (matched by
// field/variant names via msgpack), not via a Cargo dependency on each
// other's crates. See `matching::NearbyProviderView` for the same pattern.
// `pub(crate)` so `disputes.rs` can reuse them rather than redefining its
// own copies of the same ledger/reputation wire shapes.
#[derive(Serialize, Deserialize, Debug)]
pub(crate) struct SettleInputWire {
    pub(crate) order_ref: ActionHash,
    pub(crate) from: AgentPubKey,
    pub(crate) to: AgentPubKey,
    pub(crate) amount: u64,
}

#[derive(Serialize, Deserialize, Debug)]
pub(crate) struct RecordEventInputWire {
    pub(crate) subject: AgentPubKey,
    pub(crate) order_ref: ActionHash,
    pub(crate) kind: ReputationEventKindWire,
}

#[derive(Serialize, Deserialize, Debug)]
pub(crate) enum ReputationEventKindWire {
    OrderCompleted { subject_role: ReputationRoleWire },
    DisputeRaised,
    DisputeResolvedAgainst,
    CollateralForfeited { amount: u64 },
}

#[derive(Serialize, Deserialize, Debug)]
pub(crate) enum ReputationRoleWire {
    Provider,
}

const REQUIRED_LEGS_FOR_DELIVERY: u32 = 2; // MerchantHandoff + CustomerHandoff

/// The gated path to marking a delivery Delivered. Unlike `set_order_status`,
/// which trusts the integrity zome's state-machine table alone, this
/// additionally cross-zome-fetches every attested receipt for this order's
/// legs and writes their references onto `delivery_receipts` before flipping
/// the order to Delivered -- then, and only then, releases payment and
/// records a reputation event.
///
/// The completion gate itself (does this order actually have a valid
/// attestation for every required leg?) used to be trusted from here alone:
/// nothing stopped a peer from calling the lower-level `update_entry` path
/// directly to skip it. It's now enforced by `dispatch_integrity`'s
/// deterministic `validate()` too, which independently re-derives and checks
/// `delivery_receipts` against the DHT (see that crate's
/// `validate_delivery_receipts`) -- this function's own pre-check below is
/// just a fast-fail for the honest case, not the source of truth anymore.
/// `update_entry` is deliberately attempted *before* payment settlement: if
/// validation rejects the receipts for any reason this coordinator's own
/// check missed, nothing gets paid out.
#[hdk_extern]
pub fn complete_delivery(input: CompleteDeliveryInput) -> ExternResult<Record> {
    let order_record = resolve_latest(input.order_original_action.clone())?;
    let mut order: DeliveryOrder = order_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a DeliveryOrder".into())))?;

    if order.status != DeliveryStatus::PickedUp {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "an order can only be completed from the PickedUp status".into()
        )));
    }
    let accepted_bid_ref = order
        .accepted_bid
        .clone()
        .ok_or(wasm_error!(WasmErrorInner::Guest("order has no accepted bid".into())))?;
    let bid_record = resolve_latest(accepted_bid_ref)?;
    let bid: Bid = bid_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a Bid".into())))?;

    let receipts_response = call(
        CallTargetCell::Local,
        "attestation",
        "list_attested_receipts_for_order".into(),
        None,
        input.order_original_action.clone(),
    )?;
    let ZomeCallResponse::Ok(extern_io) = receipts_response else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "list_attested_receipts_for_order cross-zome call failed".into()
        )));
    };
    let attested_receipts: Vec<ActionHash> = extern_io.decode().map_err(|e| wasm_error!(e))?;
    if attested_receipts.len() < REQUIRED_LEGS_FOR_DELIVERY as usize {
        return Err(wasm_error!(WasmErrorInner::Guest(format!(
            "cannot complete delivery: {} of {} required leg attestations found",
            attested_receipts.len(),
            REQUIRED_LEGS_FOR_DELIVERY
        ))));
    }

    let requester = order.requester.clone();
    let tip_cents = order.tip_cents;
    order.status = DeliveryStatus::Delivered;
    order.delivery_receipts = attested_receipts;
    let updated = update_entry(order_record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;

    // The tip goes to the driver alongside the delivery fee itself -- same
    // recipient, same transaction, just a larger amount. Not modeled
    // separately in the reputation/ledger event trail; it's just money.
    let settle_response = call(
        CallTargetCell::Local,
        "ledger",
        "release_on_completion".into(),
        None,
        SettleInputWire {
            order_ref: input.order_original_action.clone(),
            from: requester,
            to: bid.bidder.clone(),
            amount: bid.price_offer + tip_cents,
        },
    )?;
    if !matches!(settle_response, ZomeCallResponse::Ok(_)) {
        return Err(wasm_error!(WasmErrorInner::Guest("payment settlement failed".into())));
    }

    // Best-effort: a reputation bump for the provider is valuable but
    // shouldn't block payment or delivery completion if it fails.
    let _ = call(
        CallTargetCell::Local,
        "reputation",
        "record_event".into(),
        None,
        RecordEventInputWire {
            subject: bid.bidder,
            order_ref: input.order_original_action.clone(),
            kind: ReputationEventKindWire::OrderCompleted { subject_role: ReputationRoleWire::Provider },
        },
    );

    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back completed order".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ForceOrderUpdateInput {
    pub order_original_action: ActionHash,
    pub next_status: DeliveryStatus,
    pub delivery_receipts: Vec<ActionHash>,
    #[serde(default)]
    pub dispute_ref: Option<ActionHash>,
}

/// TEST-SUPPORT ONLY -- calls `update_entry` on a `DeliveryOrder` directly
/// with caller-chosen `status`/`delivery_receipts`/`dispute_ref`, skipping
/// every coordinator-level check `set_order_status`, `complete_delivery`,
/// `raise_dispute`, and `apply_dispute_resolution` normally apply first.
/// This isn't a hypothetical attack surface: unlike integrity zomes,
/// coordinator zomes are *not* part of a DNA's hash, so nothing stops a
/// peer from writing their own coordinator wasm that calls `update_entry`
/// this directly against the same integrity zome. Exists so a test can
/// prove `dispatch_integrity::validate()` -- not this app's own honest
/// coordinator logic -- is what actually enforces the completion gate,
/// dispute-resolution gate, and field-immutability rules. No legitimate
/// client should call this.
#[hdk_extern]
pub fn force_order_update_for_testing(input: ForceOrderUpdateInput) -> ExternResult<Record> {
    let record = resolve_latest(input.order_original_action)?;
    let mut order: DeliveryOrder = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a DeliveryOrder".into())))?;
    order.status = input.next_status;
    order.delivery_receipts = input.delivery_receipts;
    order.dispute_ref = input.dispute_ref;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back forced order update".into())))
}
