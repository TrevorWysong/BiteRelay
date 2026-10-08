//! The pickup vertical's full lifecycle -- `PickupOrder`'s own doc comment
//! (`dispatch_integrity`) explains why this is a separate entry type and
//! status machine rather than a flag on `DeliveryOrder`. No bid, no driver,
//! no leg attestation: the requester and the merchant are the only two
//! parties, so this file covers creation through completion *and* its own
//! dispute path in one place, rather than splitting across files the way
//! `orders.rs`/`disputes.rs` do for the much larger delivery vertical.

use crate::orders::{ensure_claim_confirmed, ensure_promo_active, record_reputation_event, settle_order_total, ReputationEventKindWire, ReputationTargetWire, SettleInputWire};
use crate::signals::RemoteSignal;
use crate::order_queues::{self, OrderParties};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::resolve_latest_decoded;

#[derive(Serialize, Deserialize, Debug)]
pub struct RequestPickupOrderInput {
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    pub item_refs: Vec<ActionHash>,
    pub order_total: u64,
    #[serde(default)]
    pub special_instructions: String,
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
        ensure_promo_active(promo_ref)?;
    }
    if let Some(claim_ref) = &input.bag_claim_ref {
        ensure_claim_confirmed(claim_ref)?;
    }

    let order = PickupOrder {
        requester: requester.clone(),
        merchant: input.merchant,
        catalog_ref: input.catalog_ref,
        item_refs: input.item_refs,
        order_total: input.order_total,
        status: PickupStatus::Placed,
        dispute_ref: None,
        requested_at,
        special_instructions: input.special_instructions,
        promo_code_ref: input.promo_code_ref,
        bag_claim_ref: input.bag_claim_ref,
    };
    let action_hash = create_entry(&EntryTypes::PickupOrder(order))?;
    order_queues::enqueue(&action_hash, &catalog_ref, &requester, requested_at)?;

    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back pickup order".into())))
}

#[hdk_extern]
pub fn get_pickup_order(order_original_action: ActionHash) -> ExternResult<Record> {
    relay_coordinator_support::resolve_latest(order_original_action)
}

/// `Placed -> MerchantConfirmed` -- the merchant acknowledging the order,
/// same role `set_order_status`'s first step plays for deliveries.
#[hdk_extern]
pub fn confirm_pickup_prep(order_original_action: ActionHash) -> ExternResult<Record> {
    let (record, mut order): (_, PickupOrder) = resolve_latest_decoded(order_original_action, "PickupOrder")?;
    order.status = PickupStatus::MerchantConfirmed;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::PickupOrder(order))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back confirmed pickup order".into())))
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

/// Any other forward/cancellation transition that doesn't need its own
/// dedicated extern -- mirrors `orders::set_order_status`'s thin-wrapper
/// role. `PickedUp` and the two dispute-raise/resolve transitions are
/// deliberately excluded (gated, below).
#[hdk_extern]
pub fn cancel_pickup_order(order_original_action: ActionHash) -> ExternResult<Record> {
    let (record, mut order): (_, PickupOrder) = resolve_latest_decoded(order_original_action.clone(), "PickupOrder")?;
    order.status = PickupStatus::Cancelled;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::PickupOrder(order.clone()))?;
    order_queues::retire(&OrderParties::pickup(&order_original_action, &order))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back cancelled pickup order".into())))
}

/// The gated completion path -- `ReadyForPickup -> PickedUp`, called by the
/// requester confirming they actually received it. Unlike
/// `complete_delivery`, there's no leg-attestation gate to check first: the
/// merchant and requester transact directly, with no intermediary to prove
/// anything about. Settles via `settle_order_total` only -- there is no
/// delivery fee here at all, so `settle_delivery_fee` doesn't apply.
#[hdk_extern]
pub fn complete_pickup(order_original_action: ActionHash) -> ExternResult<Record> {
    let (record, mut order): (_, PickupOrder) = resolve_latest_decoded(order_original_action.clone(), "PickupOrder")?;
    if order.status != PickupStatus::ReadyForPickup {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "a pickup order can only be completed from the ReadyForPickup status".into()
        )));
    }
    let requester = order.requester.clone();
    let merchant = order.merchant.clone();
    let catalog_ref = order.catalog_ref.clone();
    let order_total = order.order_total;
    order.status = PickupStatus::PickedUp;
    let parties = OrderParties::pickup(&order_original_action, &order);
    let updated = update_entry(record.action_address().clone(), &EntryTypes::PickupOrder(order))?;
    order_queues::retire(&parties)?;

    settle_order_total(order_original_action.clone(), requester, merchant.clone(), order_total)?;

    // Best-effort: a reputation bump for the store is valuable but
    // shouldn't block payment or completion if it fails -- same posture as
    // complete_delivery's own calls. No driver-side event here at all --
    // there is no driver. Skipped for a merchant picking up from their own
    // store (see `record_reputation_event`).
    record_reputation_event(&merchant, ReputationTargetWire::Store(catalog_ref), order_original_action, ReputationEventKindWire::OrderCompleted)?;

    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back completed pickup order".into())))
}

// --- disputes -- see dispatch_integrity's check_raising_pickup_dispute/
// check_resolving_pickup_dispute doc comments for why "Provider" is
// reinterpreted as "merchant" here, the only other party there is. ---

#[derive(Serialize, Deserialize, Debug)]
struct OpenDisputeInputWire {
    order_ref: ActionHash,
    respondent: AgentPubKey,
    reason: DisputeReasonWirePickup,
    description: String,
    evidence_refs: Vec<ActionHash>,
}

// A separate wire enum from disputes.rs's own `DisputeReasonWire` rather
// than importing it -- both must match `dispute_types::DisputeReason`'s
// variant names exactly (msgpack matches by name across the zome-call
// boundary), but keeping pickup.rs's own copy avoids a cross-module
// `pub(crate)` dependency for what's otherwise two fully independent
// dispute-raising flows.
#[derive(Serialize, Deserialize, Debug)]
pub enum DisputeReasonWirePickup {
    NeverDelivered,
    WrongOrIncompleteItems,
    ProviderAbandoned,
    UnjustCancellation,
    Other,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RaisePickupDisputeInput {
    pub order_original_action: ActionHash,
    pub reason: DisputeReasonWirePickup,
    pub description: String,
    pub evidence_refs: Vec<ActionHash>,
}

/// `raise_dispute`'s pickup sibling -- derives `respondent` as whichever of
/// the order's two parties didn't raise it (trivial here, unlike
/// `derive_respondent`'s three-way delivery-vertical logic, since there's
/// no accepted-provider concept at all).
#[hdk_extern]
pub fn raise_pickup_dispute(input: RaisePickupDisputeInput) -> ExternResult<Record> {
    let (order_record, order): (_, PickupOrder) = resolve_latest_decoded(input.order_original_action.clone(), "PickupOrder")?;
    let me = agent_info()?.agent_initial_pubkey;
    // The respondent's reputation target follows the role they played on
    // this order: the merchant answers for their *store* (never their
    // other stores, or their driving), the requester as a customer.
    let (respondent, respondent_target) = if me == order.requester {
        (order.merchant.clone(), ReputationTargetWire::Store(order.catalog_ref.clone()))
    } else if me == order.merchant {
        (order.requester.clone(), ReputationTargetWire::Customer(order.requester.clone()))
    } else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only the pickup order's requester or merchant may raise a dispute".into()
        )));
    };

    let open_response = call(
        CallTargetCell::Local,
        "dispute",
        "open_dispute".into(),
        None,
        OpenDisputeInputWire {
            order_ref: input.order_original_action.clone(),
            respondent: respondent.clone(),
            reason: input.reason,
            description: input.description,
            evidence_refs: input.evidence_refs,
        },
    )?;
    let ZomeCallResponse::Ok(extern_io) = open_response else {
        return Err(wasm_error!(WasmErrorInner::Guest("dispute::open_dispute cross-zome call failed".into())));
    };
    let dispute_record: Record = extern_io.decode().map_err(|e| wasm_error!(e))?;
    let dispute_ref = dispute_record.action_address().clone();

    record_reputation_event(&respondent, respondent_target, input.order_original_action.clone(), ReputationEventKindWire::DisputeRaised)?;

    let mut updated_order = order;
    updated_order.status = PickupStatus::Disputed;
    updated_order.dispute_ref = Some(dispute_ref);
    let updated = update_entry(order_record.action_address().clone(), &EntryTypes::PickupOrder(updated_order))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back disputed pickup order".into())))
}

use dispute_types::{Dispute, DisputeOutcome};

#[derive(Serialize, Deserialize, Debug)]
pub struct ApplyPickupDisputeResolutionInput {
    pub order_original_action: ActionHash,
}

/// `apply_dispute_resolution`'s pickup sibling -- `FavorProvider` resolves
/// to `PickedUp` (the merchant's side wins, order completes and settles),
/// `FavorRequester` resolves to `Cancelled`. No delivery-fee-split, so
/// there's only ever `settle_order_total` + an optional `ledger::forfeit`
/// to apply here, not `settle_delivery_fee`'s own branch.
#[hdk_extern]
pub fn apply_pickup_dispute_resolution(input: ApplyPickupDisputeResolutionInput) -> ExternResult<Record> {
    // Synchronous gate before anything side-effecting -- see
    // disputes::apply_dispute_resolution's own doc comment for why
    // update_entry's deferred validation can't be relied on alone here.
    if !relay_governance::is_arbitrator(&agent_info()?.agent_initial_pubkey)? {
        return Err(wasm_error!(WasmErrorInner::Guest("only an arbitrator may apply a dispute resolution".into())));
    }
    let (order_record, order): (_, PickupOrder) = resolve_latest_decoded(input.order_original_action.clone(), "PickupOrder")?;
    if order.status != PickupStatus::Disputed {
        return Err(wasm_error!(WasmErrorInner::Guest("a pickup order can only have its dispute resolution applied from Disputed".into())));
    }
    let dispute_ref = order
        .dispute_ref
        .clone()
        .ok_or(wasm_error!(WasmErrorInner::Guest("order has no dispute_ref".into())))?;

    let get_response = call(CallTargetCell::Local, "dispute", "get_dispute".into(), None, dispute_ref)?;
    let ZomeCallResponse::Ok(extern_io) = get_response else {
        return Err(wasm_error!(WasmErrorInner::Guest("dispute::get_dispute cross-zome call failed".into())));
    };
    let dispute_record: Record = extern_io.decode().map_err(|e| wasm_error!(e))?;
    let dispute: Dispute = dispute_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a Dispute".into())))?;
    let outcome = dispute
        .outcome
        .ok_or(wasm_error!(WasmErrorInner::Guest("dispute has no outcome yet -- call dispute::submit_resolution first".into())))?;

    let requester = order.requester.clone();
    let merchant = order.merchant.clone();
    let catalog_ref = order.catalog_ref.clone();
    let order_total = order.order_total;
    let target_status = match &outcome {
        DisputeOutcome::FavorProvider { .. } => PickupStatus::PickedUp,
        DisputeOutcome::FavorRequester { .. } => PickupStatus::Cancelled,
    };
    let mut updated_order = order;
    let parties = OrderParties::pickup(&input.order_original_action, &updated_order);
    updated_order.status = target_status;
    updated_order.dispute_ref = Some(dispute_record.action_address().clone());
    let updated = update_entry(order_record.action_address().clone(), &EntryTypes::PickupOrder(updated_order))?;
    // Both outcomes (PickedUp / Cancelled) are terminal.
    order_queues::retire(&parties)?;

    match outcome {
        DisputeOutcome::FavorProvider { forfeit_amount } => {
            settle_order_total(input.order_original_action.clone(), requester.clone(), merchant.clone(), order_total)?;
            if forfeit_amount > 0 {
                let _ = call(
                    CallTargetCell::Local,
                    "ledger",
                    "forfeit".into(),
                    None,
                    SettleInputWire {
                        order_ref: input.order_original_action.clone(),
                        from: requester.clone(),
                        to: merchant,
                        amount: forfeit_amount,
                    },
                );
            }
            record_reputation_event(&requester, ReputationTargetWire::Customer(requester.clone()), input.order_original_action.clone(), ReputationEventKindWire::DisputeResolvedAgainst)?;
        }
        DisputeOutcome::FavorRequester { forfeit_amount } => {
            if forfeit_amount > 0 {
                let forfeit_response = call(
                    CallTargetCell::Local,
                    "ledger",
                    "forfeit".into(),
                    None,
                    SettleInputWire {
                        order_ref: input.order_original_action.clone(),
                        from: merchant.clone(),
                        to: requester,
                        amount: forfeit_amount,
                    },
                )?;
                if !matches!(forfeit_response, ZomeCallResponse::Ok(_)) {
                    return Err(wasm_error!(WasmErrorInner::Guest("collateral forfeiture failed".into())));
                }
            }
            record_reputation_event(&merchant, ReputationTargetWire::Store(catalog_ref.clone()), input.order_original_action.clone(), ReputationEventKindWire::DisputeResolvedAgainst)?;
            if forfeit_amount > 0 {
                record_reputation_event(
                    &merchant,
                    ReputationTargetWire::Store(catalog_ref),
                    input.order_original_action.clone(),
                    ReputationEventKindWire::CollateralForfeited { amount: forfeit_amount },
                )?;
            }
        }
    }

    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back resolved pickup order".into())))
}
