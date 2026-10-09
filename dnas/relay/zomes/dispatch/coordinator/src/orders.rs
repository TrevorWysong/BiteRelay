//! The delivery order lifecycle: creating one (which kicks off matching),
//! advancing its status through prep/pickup, and the gated completion path
//! that actually settles payment and reputation. See `bids.rs` for the
//! bidding steps in between, and `matching.rs`/`signals.rs` for how a new
//! order actually reaches nearby providers.

use crate::matching::{geo_presence_precision, notify_nearby_providers, open_order_anchor_path};
use crate::order_queues::{self, OrderParties};
use crate::pricing::{ensure_priced_from_current_menu, price_order, OrderItemInput};
use crate::settlement;
use crate::stores::{closed_reason, current_catalog, ready_by};
use crate::upkeep;
use crate::signals::RemoteSignal;
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, open, original_action_of, resolve_latest, resolve_latest_decoded, seal};
use relay_types::GeoPoint;

#[derive(Serialize, Deserialize, Debug)]
pub struct RequestDeliveryInput {
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    /// What to order. Priced here at each item's latest version.
    pub items: Vec<OrderItemInput>,
    /// The total the customer was shown -- the order is refused if pricing
    /// now comes to anything else.
    pub order_total: u64,
    /// The exact drop-off. Never stored in the clear: only its area is public
    /// (see `DeliveryOrder::sealed_dropoff`).
    pub dropoff: GeoPoint,
    pub max_delivery_fee: Option<u64>,
    /// A note for the kitchen -- sealed to the store.
    #[serde(default)]
    pub kitchen_notes: String,
    /// Drop-off instructions -- sealed with the address, for the driver.
    #[serde(default)]
    pub dropoff_notes: String,
    #[serde(default)]
    pub tip_cents: u64,
    /// `None` (the default) places a normal, immediately-open order. `Some`
    /// creates it in `Scheduled` status instead -- invisible to matching
    /// until `open_scheduled_order` is called at/after this time.
    #[serde(default)]
    pub requested_delivery_time: Option<Timestamp>,
    /// `None` means no promo code applied. Validated (real, belongs to
    /// this merchant, active, not expired) deterministically by
    /// `validate_new_order` -- see that function's own doc comment.
    #[serde(default)]
    pub promo_code_ref: Option<ActionHash>,
    /// Defaults to `LeaveAtDoor` -- see `DropoffPreference`'s own doc
    /// comment.
    #[serde(default)]
    pub dropoff_preference: DropoffPreference,
    /// `None` means this is a normal order, not a claimed goodie bag's
    /// delivery. `Some` is set by the customer's own client immediately
    /// after their `BagClaim` is confirmed (see `catalog::confirm_claim`'s
    /// own doc comment) -- validated (real, `Confirmed`, belongs to this
    /// requester, claimed for delivery) deterministically by
    /// `validate_new_order`.
    #[serde(default)]
    pub bag_claim_ref: Option<ActionHash>,
}

/// Publishes an order the store just accepted (`accept_delivery_order`) to
/// the discovery anchor and fires the best-effort signal fan-out to drivers
/// nearby -- nothing before the store's acceptance is ever discoverable.
/// The anchor links the accepting version (validation checks it's Open);
/// the signal names the order itself, as every other signal does.
fn publish_to_open_anchor_and_notify(order_ref: &ActionHash, opened: &ActionHash, dropoff_geohash: &str, now: Timestamp) -> ExternResult<()> {
    let bucket = relay_types::time_bucket(now.as_millis(), OPEN_ORDER_BUCKET_MILLIS);
    let path = open_order_anchor_path(dropoff_geohash, bucket)?;
    path.ensure()?;
    create_link(path.path_entry_hash()?, opened.clone(), LinkTypes::OpenOrderGeohashAnchor, ())?;

    // Best-effort fast path. A driver who missed this falls back to polling
    // get_open_orders_near -- see plan §3's named "signals can silently drop" risk.
    let _ = notify_nearby_providers(order_ref, dropoff_geohash);
    Ok(())
}

/// The caller's own name, from their profile (where it's sealed to them);
/// empty if they haven't given one.
pub(crate) fn my_name() -> ExternResult<String> {
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "profiles", "get_my_name".into(), None, ())? else {
        return Err(wasm_error!(WasmErrorInner::Guest("reading your name failed".into())));
    };
    Ok(io.decode::<Option<String>>().map_err(|e| wasm_error!(e))?.unwrap_or_default())
}

/// A note sealed to `recipient`, or `None` if there's nothing to say.
pub(crate) fn seal_note(recipient: &AgentPubKey, note: &str) -> ExternResult<Option<XSalsa20Poly1305EncryptedData>> {
    let note = note.trim();
    if note.is_empty() {
        return Ok(None);
    }
    Ok(Some(seal(recipient, &note.to_string())?))
}

/// What the caller may read of an order's sealed details: the drop-off
/// (the customer, and the driver once their bid is accepted) and the
/// kitchen note (the customer and the store). Everyone else gets nothing.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct OrderPrivateDetails {
    pub dropoff: Option<DropoffDetails>,
    pub kitchen_note: Option<String>,
    /// The customer's name -- for the customer, the store, and the driver
    /// once assigned.
    pub customer_name: Option<String>,
}

#[hdk_extern]
pub fn get_order_private_details(order_original_action: ActionHash) -> ExternResult<OrderPrivateDetails> {
    let me = agent_info()?.agent_initial_pubkey;
    let record = resolve_latest(order_original_action)?;
    if let Some(order) = decode_or::<DeliveryOrder>(&record) {
        let dropoff: Option<DropoffDetails> = if me == order.requester {
            open(&me, &order.sealed_dropoff)?
        } else {
            match &order.driver_dropoff {
                // Only the accepted driver can open their copy; anyone else gets None.
                Some(sealed) => open(&order.requester, sealed)?,
                None => None,
            }
        };
        // The store has its own copy; a driver has the one in their drop-off.
        let customer_name = match open_for_parties(&me, &order.requester, &order.merchant, order.sealed_customer_name.as_ref())? {
            Some(name) => Some(name),
            None => dropoff.as_ref().map(|d| d.recipient.clone()).filter(|name| !name.is_empty()),
        };
        let kitchen_note = open_for_parties(&me, &order.requester, &order.merchant, order.kitchen_note.as_ref())?;
        return Ok(OrderPrivateDetails { dropoff, kitchen_note, customer_name });
    }
    if let Some(order) = decode_or::<PickupOrder>(&record) {
        return Ok(OrderPrivateDetails {
            dropoff: None,
            kitchen_note: open_for_parties(&me, &order.requester, &order.merchant, order.kitchen_note.as_ref())?,
            customer_name: open_for_parties(&me, &order.requester, &order.merchant, order.sealed_customer_name.as_ref())?,
        });
    }
    Ok(OrderPrivateDetails::default())
}

/// Something sealed between the customer and the store (the kitchen note,
/// the customer's name); each opens it with the other as counterpart.
fn open_for_parties(me: &AgentPubKey, requester: &AgentPubKey, merchant: &AgentPubKey, sealed: Option<&XSalsa20Poly1305EncryptedData>) -> ExternResult<Option<String>> {
    let Some(sealed) = sealed else { return Ok(None) };
    let counterpart = if me == requester { merchant } else if me == merchant { requester } else { return Ok(None) };
    open(counterpart, sealed)
}

/// Coordinator pre-checks for an order's optional references, shared by
/// both order verticals. Validation can only see these entries as created
/// (see `dispatch_integrity::checks`), so "still active" / "confirmed yet"
/// can only be answered here, against their latest state. A failed lookup
/// lets the order through to validation rather than blocking it over a
/// convenience check that couldn't resolve.
///
/// The promo check also names the plain reasons a code can't be used here
/// (another store's, expired) up front -- validation would refuse those
/// too, but pricing runs first and would otherwise report them as a price
/// mismatch.
pub(crate) fn ensure_promo_usable(promo_ref: &ActionHash, catalog_ref: &ActionHash) -> ExternResult<()> {
    if let Ok(ZomeCallResponse::Ok(io)) = call(CallTargetCell::Local, "catalog", "get_promo_code".into(), None, promo_ref.clone()) {
        if let Ok(Some(promo)) = io.decode::<Record>().map(|r| r.entry().to_app_option::<catalog_types::PromoCode>().ok().flatten()) {
            let refuse = |reason: &str| Err(wasm_error!(WasmErrorInner::Guest(reason.into())));
            if &promo.catalog_ref != catalog_ref {
                return refuse("promo_code_ref does not belong to this order's store");
            }
            if !promo.active {
                return refuse("promo code is not active");
            }
            if promo.expires_at.is_some_and(|expires| sys_time().is_ok_and(|now| now >= expires)) {
                return refuse("promo code has expired");
            }
        }
    }
    Ok(())
}

pub(crate) fn ensure_claim_confirmed(claim_ref: &ActionHash) -> ExternResult<()> {
    if let Ok(ZomeCallResponse::Ok(io)) = call(CallTargetCell::Local, "catalog", "get_bag_claim".into(), None, claim_ref.clone()) {
        if let Ok(Some(claim)) = io.decode::<Record>().map(|r| r.entry().to_app_option::<catalog_types::BagClaim>().ok().flatten()) {
            if claim.status != catalog_types::BagClaimStatus::Confirmed {
                return Err(wasm_error!(WasmErrorInner::Guest("goodie bag claim is not yet confirmed".into())));
            }
        }
    }
    Ok(())
}

#[hdk_extern]
pub fn request_delivery(input: RequestDeliveryInput) -> ExternResult<Record> {
    let requester = agent_info()?.agent_initial_pubkey;
    let catalog_ref = input.catalog_ref.clone();
    let now = sys_time()?;
    let dropoff_geohash = relay_types::encode(input.dropoff, geo_presence_precision());
    let status = if input.requested_delivery_time.is_some() { DeliveryStatus::Scheduled } else { DeliveryStatus::Placed };

    if let Some(promo_ref) = &input.promo_code_ref {
        ensure_promo_usable(promo_ref, &input.catalog_ref)?;
    }
    if let Some(claim_ref) = &input.bag_claim_ref {
        ensure_claim_confirmed(claim_ref)?;
    }
    let priced = price_order(&input.catalog_ref, &input.items, input.promo_code_ref.as_ref(), input.bag_claim_ref.as_ref(), input.order_total)?;
    let merchant = input.merchant.clone();

    // The store as it is now: its delivery radius (a pre-check -- see
    // `ensure_promo_active` for why current settings can't be validated)
    // and its share of the delivery fee, which this order records as the
    // split it was placed under.
    let catalog = current_catalog(&input.catalog_ref)?;
    let distance = relay_types::distance_km(catalog.location, input.dropoff);
    if distance > catalog.max_delivery_radius_km {
        return Err(wasm_error!(WasmErrorInner::Guest(format!(
            "dropoff is {:.1}km away, past this store's {:.1}km delivery radius",
            distance, catalog.max_delivery_radius_km
        ))));
    }
    // Open when it's for -- now, or a scheduled order's time. A goodie bag
    // runs on its own pickup window, which the store set.
    if input.bag_claim_ref.is_none() {
        let wanted_at = input.requested_delivery_time.unwrap_or(now).as_micros();
        if let Some(reason) = closed_reason(&catalog, wanted_at) {
            return Err(wasm_error!(WasmErrorInner::Guest(reason)));
        }
    }

    let customer_name = my_name()?;
    let order = DeliveryOrder {
        requester: requester.clone(),
        merchant: merchant.clone(),
        catalog_ref: input.catalog_ref,
        lines: priced.lines,
        order_total: priced.order_total,
        dropoff_geohash: dropoff_geohash.clone(),
        sealed_dropoff: seal(&requester, &DropoffDetails { point: input.dropoff, notes: input.dropoff_notes, recipient: customer_name.clone() })?,
        driver_dropoff: None,
        kitchen_note: seal_note(&merchant, &input.kitchen_notes)?,
        sealed_customer_name: seal_note(&merchant, &customer_name)?,
        max_delivery_fee: input.max_delivery_fee,
        status,
        accepted_bid: None,
        delivery_receipts: Vec::new(),
        dispute_ref: None,
        requested_at: now,
        tip_cents: input.tip_cents,
        delivery_subsidy_percent: catalog.delivery_subsidy_percent,
        requested_delivery_time: input.requested_delivery_time,
        promo_code_ref: input.promo_code_ref,
        dropoff_preference: input.dropoff_preference,
        bag_claim_ref: input.bag_claim_ref,
        loyalty_proof: priced.loyalty_proof,
        cancellation: None,
        collateral_hold: None,
        ready_by: None,
    };
    let action_hash = create_entry(&EntryTypes::DeliveryOrder(order))?;
    // The store finds it in its queue; drivers only once the store accepts
    // it (`accept_delivery_order`).
    order_queues::enqueue(&action_hash, &catalog_ref, &requester, now)?;
    // This conductor sends a scheduled order to the store when it's due,
    // and cancels one the store never answers -- see `upkeep`.
    upkeep::tend_my_orders_soon()?;

    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back delivery order".into())))
}

/// The one narrow transition out of `Scheduled`: placing the order with its
/// store once its time arrives. The customer's conductor does this on its
/// own (`upkeep`); fails fast, as a convenience, if it's clearly too early
/// -- `validate_order_transition`'s check against this update's own
/// recorded timestamp is the real, deterministic enforcement.
#[hdk_extern]
pub fn open_scheduled_order(order_original_action: ActionHash) -> ExternResult<Record> {
    let (record, mut order): (_, DeliveryOrder) = resolve_latest_decoded(order_original_action, "DeliveryOrder")?;
    if order.status != DeliveryStatus::Scheduled {
        return Err(wasm_error!(WasmErrorInner::Guest("order is not Scheduled".into())));
    }
    let now = sys_time()?;
    if let Some(due) = order.requested_delivery_time {
        if now < due {
            return Err(wasm_error!(WasmErrorInner::Guest(
                "requested_delivery_time has not arrived yet".into()
            )));
        }
    }
    order.status = DeliveryStatus::Placed;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;
    upkeep::tend_my_orders_soon()?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back opened order".into())))
}

/// `Placed -> Open` -- the store accepting a delivery order, which is what
/// puts it in front of drivers: published under its drop-off area and
/// signalled to drivers nearby. Only the store can (validation), and only
/// once it's checked the order is priced from its current menu
/// (`ensure_priced_from_current_menu`) -- a refused order never reaches a
/// driver. The store declines with `decline_order`; its conductor can do
/// either on its own (`upkeep`, for a store set to auto-accept).
#[derive(Serialize, Deserialize, Debug)]
pub struct AcceptOrderInput {
    pub order_original_action: ActionHash,
    /// How long the kitchen expects this one to take; the store's usual
    /// prep time if `None`. Recorded as the order's `ready_by`.
    #[serde(default)]
    pub prep_minutes: Option<u16>,
}

#[hdk_extern]
pub fn accept_delivery_order(input: AcceptOrderInput) -> ExternResult<Record> {
    let order_original_action = input.order_original_action;
    let (record, mut order): (_, DeliveryOrder) = resolve_latest_decoded(order_original_action.clone(), "DeliveryOrder")?;
    if order.status != DeliveryStatus::Placed {
        return Err(wasm_error!(WasmErrorInner::Guest("this order has already been accepted or cancelled".into())));
    }
    if order.merchant != agent_info()?.agent_initial_pubkey {
        return Err(wasm_error!(WasmErrorInner::Guest("only the order's store can accept it".into())));
    }
    ensure_priced_from_current_menu(&order_original_action, &order.lines, order.bag_claim_ref.as_ref())?;
    order.ready_by = Some(ready_by(&order.catalog_ref, input.prep_minutes)?);
    order.status = DeliveryStatus::Open;
    let dropoff_geohash = order.dropoff_geohash.clone();
    let updated = update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;
    publish_to_open_anchor_and_notify(&original_action_of(order_original_action)?, &updated, &dropoff_geohash, sys_time()?)?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back accepted order".into())))
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
    if input.next_status == DeliveryStatus::Open {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "use accept_delivery_order to open an order to drivers -- it checks the order's prices first".into()
        )));
    }
    if input.next_status == DeliveryStatus::Cancelled {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "use cancel_order or decline_order to cancel an order -- they record why".into()
        )));
    }
    if input.next_status == DeliveryStatus::PickedUp {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "use pick_up_order to pick an order up -- it posts the driver's collateral".into()
        )));
    }
    if input.next_status == DeliveryStatus::Delivered {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "use complete_delivery to mark an order Delivered -- it verifies leg attestations first".into()
        )));
    }
    let (record, mut order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_original_action.clone(), "DeliveryOrder")?;
    order.status = input.next_status;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order.clone()))?;
    if order.status.is_terminal() {
        order_queues::retire(&OrderParties::delivery(&input.order_original_action, &order)?)?;
    }
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back updated order".into())))
}

/// How long a store has to accept an order, in seconds -- the DNA's
/// `store_response_secs` (see `relay_governance::store_response_window`),
/// for the app's countdowns.
#[hdk_extern]
pub fn get_store_response_secs(_: ()) -> ExternResult<u64> {
    Ok(relay_governance::store_response_window().as_secs())
}

/// Mirrors `ledger::HoldCollateralInput` over the zome-call boundary.
#[derive(Serialize, Deserialize, Debug)]
struct HoldCollateralWire {
    related_order: ActionHash,
    basis: ActionHash,
    to: AgentPubKey,
    amount: u64,
}

/// The driver picking the order up from the store: they post their
/// collateral to the customer -- the value of the food they now carry --
/// and the same update records it (validation requires both together).
/// The customer hands it back on delivery (`PaymentLeg::CollateralReturn`).
#[hdk_extern]
pub fn pick_up_order(order_original_action: ActionHash) -> ExternResult<Record> {
    let (record, mut order): (_, DeliveryOrder) = resolve_latest_decoded(order_original_action.clone(), "DeliveryOrder")?;
    if order.status != DeliveryStatus::DriverEnRouteToMerchant {
        return Err(wasm_error!(WasmErrorInner::Guest("an order is picked up once its driver is at the store".into())));
    }
    let bid_ref = order.accepted_bid.clone().ok_or(wasm_error!(WasmErrorInner::Guest("this order has no driver".into())))?;
    let (_, bid): (_, Bid) = resolve_latest_decoded(bid_ref, "Bid")?;
    let hold = HoldCollateralWire { related_order: original_action_of(order_original_action)?, basis: record.action_address().clone(), to: order.requester.clone(), amount: bid.collateral };
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "ledger", "hold_collateral".into(), None, hold)? else {
        return Err(wasm_error!(WasmErrorInner::Guest("posting your collateral failed".into())));
    };
    let hold_record: Record = io.decode().map_err(|e| wasm_error!(e))?;
    order.status = DeliveryStatus::PickedUp;
    order.collateral_hold = Some(hold_record.action_address().clone());
    let updated = update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back picked-up order".into())))
}

/// The customer withdrawing their delivery. Validation allows it until the
/// driver picks it up; the app offers it until the store starts preparing.
#[hdk_extern]
pub fn cancel_order(order_original_action: ActionHash) -> ExternResult<Record> {
    cancel_delivery(order_original_action, Cancellation::ByCustomer)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DeclineOrderInput {
    pub order_original_action: ActionHash,
    pub reason: DeclineReason,
}

/// The store turning a delivery down -- or calling it off after accepting
/// it -- and telling the customer why.
#[hdk_extern]
pub fn decline_order(input: DeclineOrderInput) -> ExternResult<Record> {
    cancel_delivery(input.order_original_action, Cancellation::ByStore(input.reason))
}

/// Cancels a delivery for `reason`, which validation checks against the
/// caller, and takes it off every queue.
pub(crate) fn cancel_delivery(order_original_action: ActionHash, reason: Cancellation) -> ExternResult<Record> {
    let (record, mut order): (_, DeliveryOrder) = resolve_latest_decoded(order_original_action.clone(), "DeliveryOrder")?;
    order.status = DeliveryStatus::Cancelled;
    order.cancellation = Some(reason);
    let updated = update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order.clone()))?;
    order_queues::retire(&OrderParties::delivery(&order_original_action, &order)?)?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back cancelled order".into())))
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
pub(crate) struct RecordEventInputWire {
    pub(crate) target: ReputationTargetWire,
    pub(crate) order_ref: ActionHash,
    pub(crate) kind: ReputationEventKindWire,
}

/// Mirrors `reputation_integrity::ReputationTarget` -- an event is about a
/// store, or an agent in one specific role, never a bare agent.
#[derive(Serialize, Deserialize, Debug)]
pub(crate) enum ReputationTargetWire {
    Store(ActionHash),
    Driver(AgentPubKey),
    Customer(AgentPubKey),
}

#[derive(Serialize, Deserialize, Debug)]
pub(crate) enum ReputationEventKindWire {
    OrderCompleted,
    DisputeRaised,
    DisputeResolvedAgainst,
    CollateralForfeited { amount: u64 },
}

/// Best-effort reputation bookkeeping shared by every completion/dispute
/// path in this crate. Skips an event whose subject would be the caller
/// themselves -- `reputation_integrity::validate_event` rejects
/// subject == counterparty, which happens legitimately when a merchant
/// orders from their own store (see `settle_order_total`). That skip
/// matters beyond tidiness: even behind `let _`, a nested `call` whose
/// commit fails validation was observed to fail *this* call's whole commit
/// too (pinned by `pickup-self-order.test.ts`), so an event that's certain
/// to be rejected must never be attempted.
pub(crate) fn record_reputation_event(subject: &AgentPubKey, target: ReputationTargetWire, order_ref: ActionHash, kind: ReputationEventKindWire) -> ExternResult<()> {
    if subject == &agent_info()?.agent_initial_pubkey {
        return Ok(());
    }
    let _ = call(CallTargetCell::Local, "reputation", "record_event".into(), None, RecordEventInputWire { target, order_ref, kind });
    Ok(())
}

const REQUIRED_LEGS_FOR_DELIVERY: u32 = 2; // MerchantHandoff + CustomerHandoff

/// The gated path to marking a delivery Delivered. Unlike `set_order_status`,
/// which trusts the integrity zome's state-machine table alone, this
/// additionally cross-zome-fetches every attested receipt for this order's
/// legs and writes their references onto `delivery_receipts` before flipping
/// the order to Delivered -- then, and only then, releases payment and
/// records a reputation event.
///
/// The completion gate (a valid attestation for every required leg) is
/// enforced by validation, which re-checks `delivery_receipts` against the
/// DHT (`validate_delivery_receipts`); the pre-check here only fails fast
/// for honest callers. The order is updated *before* any payment, so if
/// validation rejects the receipts, nothing is paid out.
#[hdk_extern]
pub fn complete_delivery(input: CompleteDeliveryInput) -> ExternResult<Record> {
    let (order_record, mut order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_original_action.clone(), "DeliveryOrder")?;

    if order.status != DeliveryStatus::PickedUp {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "an order can only be completed from the PickedUp status".into()
        )));
    }
    let accepted_bid_ref = order
        .accepted_bid
        .clone()
        .ok_or(wasm_error!(WasmErrorInner::Guest("order has no accepted bid".into())))?;
    let (_, bid): (_, Bid) = resolve_latest_decoded(accepted_bid_ref, "Bid")?;

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

    let parties = OrderParties::delivery(&input.order_original_action, &order)?;
    let merchant = order.merchant.clone();
    let catalog_ref = order.catalog_ref.clone();
    order.status = DeliveryStatus::Delivered;
    order.delivery_receipts = attested_receipts;
    let owed = delivery_payments(&order, &bid);
    let updated = update_entry(order_record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;
    order_queues::retire(&parties)?;

    // The customer pays what they owe now; the store pays its fee share
    // from its own conductor, told here that it's due (the sweep in
    // `settlement` catches a missed signal).
    let me = agent_info()?.agent_initial_pubkey;
    settlement::pay_legs(&input.order_original_action, &updated, &owed, settlement::Payer::Me(&me))?;
    if owed.iter().any(|p| p.leg == PaymentLeg::DeliveryFeeStoreShare && p.from != me) {
        let _ = send_remote_signal(RemoteSignal::StoreShareDue { order_hash: input.order_original_action.clone() }, vec![merchant.clone()]);
    }

    // Best-effort: reputation bumps are valuable but shouldn't block
    // payment or delivery completion if they fail. One per role this order
    // actually involved -- the driver's completed delivery, and the store's
    // completed order -- each counted only toward its own target.
    record_reputation_event(&bid.bidder, ReputationTargetWire::Driver(bid.bidder.clone()), input.order_original_action.clone(), ReputationEventKindWire::OrderCompleted)?;
    record_reputation_event(&merchant, ReputationTargetWire::Store(catalog_ref), input.order_original_action.clone(), ReputationEventKindWire::OrderCompleted)?;

    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back completed order".into())))
}

