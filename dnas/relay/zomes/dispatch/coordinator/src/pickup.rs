//! The pickup vertical's full lifecycle -- `PickupOrder`'s own doc comment
//! (`dispatch_integrity`) explains why this is a separate entry type and
//! status machine rather than a flag on `DeliveryOrder`. No bid, no driver,
//! no leg attestation: the requester and the merchant are the only two
//! parties, so this file covers creation through completion *and* its own
//! dispute path in one place, rather than splitting across files the way
//! `orders.rs`/`disputes.rs` do for the much larger delivery vertical.

use crate::upkeep;
use crate::stores::{closed_reason, current_catalog_version, ready_by};
use crate::orders::{ensure_claim_confirmed, ensure_promo_usable, my_name, seal_note, AcceptOrderInput, DeclineOrderInput, record_reputation_event, ReputationEventKindWire, ReputationTargetWire};
use crate::pricing::{ensure_current_terms, ensure_priced_from_current_menu, ensure_store_minimum, price_order, OrderItem};
use crate::settlement;
use crate::signals::RemoteSignal;
use crate::order_queues::{self, OrderParties};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::resolve_latest_decoded;

#[derive(Serialize, Deserialize, Debug)]
pub struct RequestPickupOrderInput {
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    /// What to order -- see `RequestDeliveryInput::items`.
    pub items: Vec<OrderItem>,
    /// The total the customer was shown -- see `RequestDeliveryInput::order_total`.
    pub order_total: u64,
    /// A note for the kitchen -- sealed to the store.
    #[serde(default)]
    pub kitchen_notes: String,
    #[serde(default)]
    pub promo_code_ref: Option<ActionHash>,
    #[serde(default)]
    pub bag_claim_ref: Option<ActionHash>,
}

/// No matching/signal-fanout step here unlike `orders::request_delivery` --
/// there's no driver to find, so the only two parties who ever need to know
/// about this order are the two already named on it. The store still
/// needs to find it, through the same store queues deliveries use.
#[hdk_extern]
pub fn request_pickup_order(input: RequestPickupOrderInput) -> ExternResult<Record> {
    let requester = agent_info()?.agent_initial_pubkey;
    let catalog_ref = input.catalog_ref.clone();
    let requested_at = sys_time()?;

    if let Some(promo_ref) = &input.promo_code_ref {
        ensure_promo_usable(promo_ref, &input.catalog_ref)?;
    }
    if let Some(claim_ref) = &input.bag_claim_ref {
        ensure_claim_confirmed(claim_ref)?;
    }
    order_queues::ensure_order_rate()?;
    let priced = price_order(&input.catalog_ref, &input.items, input.promo_code_ref.as_ref(), input.bag_claim_ref.as_ref(), input.order_total)?;
    // The store as it is now: the terms this order is placed under.
    let (catalog_version, catalog) = current_catalog_version(&input.catalog_ref)?;
    ensure_store_minimum(&catalog, &priced)?;
    // Open now -- a goodie bag runs on its own pickup window instead.
    if input.bag_claim_ref.is_none() {
        if let Some(reason) = closed_reason(&catalog, requested_at.as_micros()) {
            return Err(wasm_error!(WasmErrorInner::Guest(reason)));
        }
    }

    let kitchen_note = seal_note(&input.merchant, &input.kitchen_notes)?;
    let sealed_customer_name = seal_note(&input.merchant, &my_name()?)?;
    let order = PickupOrder {
        requester: requester.clone(),
        merchant: input.merchant,
        catalog_ref: input.catalog_ref,
        catalog_version,
        lines: priced.lines,
        order_total: priced.order_total,
        status: PickupStatus::Placed,
        requested_at,
        kitchen_note,
        sealed_customer_name,
        promo_code_ref: input.promo_code_ref,
        bag_claim_ref: input.bag_claim_ref,
        loyalty_proof: priced.loyalty_proof,
        cancellation: None,
        ready_by: None,
        food_hold: None,
    };
    let action_hash = create_entry(&EntryTypes::PickupOrder(order))?;
    // Paid for up front, in this same commit -- see `request_delivery`.
    settlement::place_hold(&action_hash, HoldPurpose::Food)?;
    order_queues::enqueue(&action_hash, &catalog_ref, &requester, requested_at)?;
    upkeep::tend_my_orders_soon()?;

    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back pickup order".into())))
}

#[hdk_extern]
pub fn get_pickup_order(order_original_action: ActionHash) -> ExternResult<Record> {
    relay_coordinator_support::resolve_latest(order_original_action)
}

/// `Placed -> MerchantConfirmed` -- the store accepting the order and
/// starting on it, once it's checked the order is priced from its current
/// menu (see `ensure_priced_from_current_menu`), and saying when it'll be
/// ready. Only the store can.
#[hdk_extern]
pub fn accept_pickup_order(input: AcceptOrderInput) -> ExternResult<Record> {
    let order_original_action = input.order_original_action;
    let (record, mut order): (_, PickupOrder) = resolve_latest_decoded(order_original_action.clone(), "PickupOrder")?;
    if order.status != PickupStatus::Placed {
        return Err(wasm_error!(WasmErrorInner::Guest("this order has already been accepted or cancelled".into())));
    }
    if order.merchant != agent_info()?.agent_initial_pubkey {
        return Err(wasm_error!(WasmErrorInner::Guest("only the order's store can accept it".into())));
    }
    ensure_priced_from_current_menu(&order_original_action, &order.lines, order.bag_claim_ref.as_ref(), order.promo_code_ref.as_ref())?;
    ensure_current_terms(&order_original_action, &order.catalog_ref, &order.catalog_version)?;
    if let Some(claim_ref) = &order.bag_claim_ref {
        crate::claims::redeem_bag_claim(claim_ref)?;
    }
    let original = relay_coordinator_support::original_action_of(order_original_action.clone())?;
    order.food_hold = settlement::required_hold(&original, HoldPurpose::Food, &order.requester, settlement::owes(&original, &HoldPurpose::Food, None)?)?;
    order.ready_by = Some(ready_by(&order.catalog_ref, input.prep_minutes)?);
    order.status = PickupStatus::MerchantConfirmed;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::PickupOrder(order))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back accepted pickup order".into())))
}

/// `MerchantConfirmed -> ReadyForPickup` -- signals the requester directly
/// (best-effort fast path, same posture as every other signal in this
/// crate; the requester's own client falls back to polling `get_pickup_order`
/// if it's missed).
#[hdk_extern]
pub fn mark_ready_for_pickup(order_original_action: ActionHash) -> ExternResult<Record> {
    let (record, mut order): (_, PickupOrder) = resolve_latest_decoded(order_original_action, "PickupOrder")?;
    order.status = PickupStatus::ReadyForPickup;
    let requester = order.requester.clone();
    let updated = update_entry(record.action_address().clone(), &EntryTypes::PickupOrder(order))?;
    let _ = send_remote_signal(RemoteSignal::PickupReady { order_hash: updated.clone() }, vec![requester]);
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back ready pickup order".into())))
}

/// The customer withdrawing their pickup order -- see `orders::cancel_order`.
#[hdk_extern]
pub fn cancel_pickup_order(order_original_action: ActionHash) -> ExternResult<Record> {
    cancel_pickup(order_original_action, Cancellation::ByCustomer)
}

/// The store turning a pickup order down, or calling it off, and why.
#[hdk_extern]
pub fn decline_pickup_order(input: DeclineOrderInput) -> ExternResult<Record> {
    cancel_pickup(input.order_original_action, Cancellation::ByStore(input.reason))
}

/// Cancels a pickup order for `reason`, which validation checks against the
/// caller, and takes it off every queue.
pub(crate) fn cancel_pickup(order_original_action: ActionHash, reason: Cancellation) -> ExternResult<Record> {
    let (record, mut order): (_, PickupOrder) = resolve_latest_decoded(order_original_action.clone(), "PickupOrder")?;
    order.status = PickupStatus::Cancelled;
    order.cancellation = Some(reason);
    let updated = update_entry(record.action_address().clone(), &EntryTypes::PickupOrder(order.clone()))?;
    order_queues::retire(&OrderParties::pickup(&order_original_action, &order))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back cancelled pickup order".into())))
}

/// The gated completion path -- `ReadyForPickup -> PickedUp`, called by the
/// requester confirming they actually received it. Unlike
/// `complete_delivery`, there's no leg-attestation gate to check first: the
/// merchant and requester transact directly, with no intermediary to prove
/// anything about. The customer pays the order total; there's no delivery
/// fee or tip.
#[hdk_extern]
pub fn complete_pickup(order_original_action: ActionHash) -> ExternResult<Record> {
    let (record, mut order): (_, PickupOrder) = resolve_latest_decoded(order_original_action.clone(), "PickupOrder")?;
    if !matches!(order.status, PickupStatus::ReadyForPickup | PickupStatus::Disputed) {
        return Err(wasm_error!(WasmErrorInner::Guest("a pickup order can only be collected once it's ready".into())));
    }
    let merchant = order.merchant.clone();
    let catalog_ref = order.catalog_ref.clone();
    order.status = PickupStatus::PickedUp;
    let parties = OrderParties::pickup(&order_original_action, &order);
    let updated = update_entry(record.action_address().clone(), &EntryTypes::PickupOrder(order))?;
    order_queues::retire(&parties)?;
    // This update is the customer's receipt: the store settles the food's
    // held payment on it once their report window has run (`issues`).

    // The store's completed order, on the version completing it. Skipped
    // for a merchant picking up from their own store (see `record_reputation_event`).
    record_reputation_event(&merchant, ReputationTargetWire::Store(catalog_ref), order_original_action, ReputationEventKindWire::OrderCompleted, updated.clone())?;

    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back completed pickup order".into())))
}

/// The customer telling the store they can't get their order (it isn't
/// there, or isn't being handed over). The store then hands it over (the
/// customer collects it as usual) or cancels it, returning their money
/// (`decline_pickup_order`).
#[hdk_extern]
pub fn report_pickup_problem(order_original_action: ActionHash) -> ExternResult<Record> {
    let (record, mut order): (_, PickupOrder) = resolve_latest_decoded(order_original_action.clone(), "PickupOrder")?;
    if order.status != PickupStatus::ReadyForPickup {
        return Err(wasm_error!(WasmErrorInner::Guest("you can report a problem once the store says it's ready".into())));
    }
    order.status = PickupStatus::Disputed;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::PickupOrder(order))?;
    get(updated, GetOptions::local())?.ok_or(wasm_error!(WasmErrorInner::Guest("could not read back the order".into())))
}
