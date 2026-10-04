//! The delivery order lifecycle: creating one (which kicks off matching),
//! advancing its status through prep/pickup, and the gated completion path
//! that actually settles payment and reputation. See `bids.rs` for the
//! bidding steps in between, and `matching.rs`/`signals.rs` for how a new
//! order actually reaches nearby providers.

use crate::matching::{geo_presence_precision, notify_nearby_providers, open_order_anchor_path, OPEN_ORDER_BUCKET_MILLIS};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{resolve_latest, resolve_latest_decoded, resolve_links_to_records};
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
}

/// Publishes an already-Open order to the discovery anchor and fires the
/// best-effort signal fan-out -- shared by `request_delivery` (immediate
/// orders) and `open_scheduled_order` (a scheduled order finally becoming
/// live), since a `Scheduled` order must not be discoverable or signaled
/// until it's genuinely Open.
fn publish_to_open_anchor_and_notify(action_hash: &ActionHash, dropoff_geohash: &str, now: Timestamp) -> ExternResult<()> {
    let bucket = relay_types::time_bucket(now.as_millis(), OPEN_ORDER_BUCKET_MILLIS);
    let path = open_order_anchor_path(dropoff_geohash, bucket)?;
    path.ensure()?;
    create_link(path.path_entry_hash()?, action_hash.clone(), LinkTypes::OpenOrderGeohashAnchor, ())?;

    // Best-effort fast path. A driver who missed this falls back to polling
    // get_open_orders_near -- see plan §3's named "signals can silently drop" risk.
    let _ = notify_nearby_providers(action_hash, dropoff_geohash);
    Ok(())
}

#[hdk_extern]
pub fn request_delivery(input: RequestDeliveryInput) -> ExternResult<Record> {
    let requester = agent_info()?.agent_initial_pubkey;
    let merchant = input.merchant.clone();
    let now = sys_time()?;
    let dropoff_geohash = relay_types::encode(input.dropoff, geo_presence_precision());
    let status = if input.requested_delivery_time.is_some() { DeliveryStatus::Scheduled } else { DeliveryStatus::Open };
    let is_open = status == DeliveryStatus::Open;

    // Best-effort "is this code still active" pre-check -- see
    // `dispatch_integrity::validate_new_order`'s own doc comment for why
    // this genuinely can't be the deterministic source of truth (only
    // `catalog_ref` match and `expires_at` are enforced there). A failed
    // lookup here degrades to "let validate() decide on what it actually
    // can check" rather than blocking the order over a convenience
    // pre-check that couldn't resolve.
    if let Some(promo_ref) = &input.promo_code_ref {
        let response = call(CallTargetCell::Local, "catalog", "get_promo_code".into(), None, promo_ref.clone());
        if let Ok(ZomeCallResponse::Ok(extern_io)) = response {
            if let Ok(record) = extern_io.decode::<Record>() {
                if let Ok(Some(promo)) = record.entry().to_app_option::<catalog_types::PromoCode>() {
                    if !promo.active {
                        return Err(wasm_error!(WasmErrorInner::Guest("promo code is not active".into())));
                    }
                }
            }
        }
    }

    let order = DeliveryOrder {
        requester: requester.clone(),
        merchant: input.merchant,
        catalog_ref: input.catalog_ref,
        item_refs: input.item_refs,
        order_total: input.order_total,
        dropoff: input.dropoff,
        dropoff_geohash: dropoff_geohash.clone(),
        max_delivery_fee: input.max_delivery_fee,
        status,
        accepted_bid: None,
        delivery_receipts: Vec::new(),
        dispute_ref: None,
        requested_at: now,
        special_instructions: input.special_instructions,
        tip_cents: input.tip_cents,
        requested_delivery_time: input.requested_delivery_time,
        promo_code_ref: input.promo_code_ref,
        dropoff_preference: input.dropoff_preference,
    };
    let action_hash = create_entry(&EntryTypes::DeliveryOrder(order))?;
    create_link(requester, action_hash.clone(), LinkTypes::RequesterToOrder, ())?;
    // The merchant is never in `notify_nearby_providers`'s signal audience
    // below (that's providers only) and has no anchor of their own to poll
    // -- without this link a merchant has no way to discover an order
    // naming them at all, not even a delayed one. Mirrors RequesterToOrder.
    create_link(merchant, action_hash.clone(), LinkTypes::MerchantToOrder, ())?;

    if is_open {
        publish_to_open_anchor_and_notify(&action_hash, &dropoff_geohash, now)?;
    }

    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back delivery order".into())))
}

/// The one narrow transition out of `Scheduled` -- fails fast, as a
/// convenience, if it's clearly too early; `validate_order_transition`'s own
/// check (against this *update action's* own recorded timestamp, not a
/// fresh `sys_time()` call) is the real, deterministic enforcement. There's
/// no server-side scheduler here: the requester's own client is expected to
/// call this once the time arrives, the same client-driven-polling pattern
/// this app already relies on everywhere else (presence beacons, the
/// matching backstop).
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
    order.status = DeliveryStatus::Open;
    let dropoff_geohash = order.dropoff_geohash.clone();
    let updated = update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;
    publish_to_open_anchor_and_notify(&updated, &dropoff_geohash, now)?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back opened order".into())))
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
    Ok(resolve_links_to_records(links))
}

/// The `MerchantToOrder` counterpart -- unlike the requester's own read
/// above, these links were authored by *other* agents (each order's
/// requester), so this genuinely depends on gossip having propagated them
/// to whatever authority holds basis for the merchant's own pubkey.
#[hdk_extern]
pub fn get_orders_for_merchant(merchant: AgentPubKey) -> ExternResult<Vec<Record>> {
    let links = get_links(LinkQuery::try_new(merchant, LinkTypes::MerchantToOrder)?, GetStrategy::default())?;
    Ok(resolve_links_to_records(links))
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
    let (record, mut order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_original_action, "DeliveryOrder")?;
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

/// Cross-zome-fetches the order's merchant catalog for its currently-set
/// `delivery_subsidy_percent` (architecture plan §12, 2026-10-01 revision:
/// the standard delivery-cost-sharing model, defaulting to an even 50/50
/// split with the customer -- not a rare promotion) and splits
/// `price_offer` between merchant and customer proportionally:
/// `merchant_share = price_offer * percent / 100`, floor-rounded, with any
/// rounding remainder landing on the customer's side. The driver is always
/// paid `price_offer` in full regardless of the split -- this only changes
/// *where* the money comes from, never the amount owed. Any tip is always
/// the customer's alone, never subject to the split. A failed/missing
/// subsidy lookup degrades to 0% (fully customer-paid) rather than blocking
/// settlement over a bonus lookup -- but once a nonzero merchant share is
/// actually owed, both settle calls must succeed, or the driver would be
/// paid less than the `price_offer` they were promised.
/// Pays the merchant for the food itself -- a completely separate flow from
/// `settle_delivery_fee` below, which only ever moves the delivery fee/tip
/// to the driver. `amount` is the order's `order_total`, already net of
/// any applied promo-code discount by the time this is called.
pub(crate) fn settle_order_total(order_ref: ActionHash, customer: AgentPubKey, merchant: AgentPubKey, amount: u64) -> ExternResult<()> {
    // A customer ordering from their own restaurant is legitimate (unlike a
    // driver bidding on their own order, see validate_new_bid) -- but it's
    // economically a no-op, and `ledger_integrity::validate_transaction`
    // correctly rejects any from == to transaction as meaningless
    // bookkeeping. Skip rather than attempt one.
    if amount == 0 || customer == merchant {
        return Ok(());
    }
    let response = call(
        CallTargetCell::Local,
        "ledger",
        "release_on_completion".into(),
        None,
        SettleInputWire { order_ref, from: customer, to: merchant, amount },
    )?;
    if !matches!(response, ZomeCallResponse::Ok(_)) {
        return Err(wasm_error!(WasmErrorInner::Guest("order-total settlement failed".into())));
    }
    Ok(())
}

pub(crate) fn settle_delivery_fee(
    order_ref: ActionHash,
    catalog_ref: ActionHash,
    customer: AgentPubKey,
    merchant: AgentPubKey,
    driver: AgentPubKey,
    price_offer: u64,
    tip_cents: u64,
) -> ExternResult<()> {
    let subsidy_response = call(CallTargetCell::Local, "catalog", "get_delivery_subsidy".into(), None, catalog_ref.clone());
    let subsidy_percent: u8 = match subsidy_response {
        Ok(ZomeCallResponse::Ok(extern_io)) => extern_io.decode().unwrap_or(0),
        _ => 0,
    }
    .min(100);
    let merchant_share = price_offer * subsidy_percent as u64 / 100;
    let customer_share = price_offer - merchant_share;

    if merchant_share > 0 {
        let response = call(
            CallTargetCell::Local,
            "ledger",
            "release_on_completion".into(),
            None,
            SettleInputWire { order_ref: order_ref.clone(), from: merchant, to: driver.clone(), amount: merchant_share },
        )?;
        if !matches!(response, ZomeCallResponse::Ok(_)) {
            return Err(wasm_error!(WasmErrorInner::Guest("merchant delivery-subsidy settlement failed".into())));
        }
    }

    let response = call(
        CallTargetCell::Local,
        "ledger",
        "release_on_completion".into(),
        None,
        SettleInputWire { order_ref, from: customer, to: driver, amount: customer_share + tip_cents },
    )?;
    if !matches!(response, ZomeCallResponse::Ok(_)) {
        return Err(wasm_error!(WasmErrorInner::Guest("payment settlement failed".into())));
    }
    Ok(())
}

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

    let requester = order.requester.clone();
    let merchant = order.merchant.clone();
    let catalog_ref = order.catalog_ref.clone();
    let tip_cents = order.tip_cents;
    let order_total = order.order_total;
    order.status = DeliveryStatus::Delivered;
    order.delivery_receipts = attested_receipts;
    let updated = update_entry(order_record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;

    // Food payment, entirely separate from the delivery-fee split above --
    // customer pays the merchant for what was ordered, regardless of how
    // the delivery fee itself gets split. Previously missing entirely: the
    // merchant was never actually paid anything through the ledger.
    settle_order_total(input.order_original_action.clone(), requester.clone(), merchant.clone(), order_total)?;

    settle_delivery_fee(
        input.order_original_action.clone(),
        catalog_ref,
        requester,
        merchant,
        bid.bidder.clone(),
        bid.price_offer,
        tip_cents,
    )?;

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
    let (record, mut order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_original_action, "DeliveryOrder")?;
    order.status = input.next_status;
    order.delivery_receipts = input.delivery_receipts;
    order.dispute_ref = input.dispute_ref;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back forced order update".into())))
}
