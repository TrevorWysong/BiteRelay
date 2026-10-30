//! The delivery order lifecycle: creating one (which kicks off matching),
//! advancing its status through prep/pickup, and the gated completion path
//! that actually settles payment and reputation. See `bids.rs` for the
//! bidding steps in between, and `matching.rs`/`signals.rs` for how a new
//! order actually reaches nearby providers.

use crate::matching::open_order_anchor_path;
use crate::order_queues::{self, OrderParties};
use crate::pricing::{ensure_current_terms, ensure_priced_from_current_menu, ensure_store_minimum, price_order, OrderItem};
use crate::settlement;
use crate::stores::{closed_reason, current_catalog, current_catalog_version};
use crate::upkeep;
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, guest, open, original_action_of, resolve_latest, resolve_version_decoded, seal, update_version, written};
use relay_types::GeoPoint;

#[derive(Serialize, Deserialize, Debug)]
pub struct RequestDeliveryInput {
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    /// What to order. Priced here at each item's latest version.
    pub items: Vec<OrderItem>,
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
    /// The customer accepting that an order left at their door is
    /// delivered once it's left -- required to choose `LeaveAtDoor`.
    #[serde(default)]
    pub door_risk_accepted: bool,
    /// A driver of the customer's own: one carrying no other order (see
    /// `DeliveryOrder::priority`).
    #[serde(default)]
    pub priority: bool,
    /// Let the app choose a driver from the bids, by the network's published
    /// rule (`matching::rank_bids`) -- or `false` to choose yourself.
    #[serde(default)]
    pub auto_match: bool,
    /// `None` means this is a normal order, not a claimed goodie bag's
    /// delivery. `Some` is set by the customer's own client immediately
    /// after their `BagClaim` is confirmed (see `catalog::confirm_claim`'s
    /// own doc comment) -- validated (real, `Confirmed`, belongs to this
    /// requester, claimed for delivery) deterministically by
    /// `validate_new_order`.
    #[serde(default)]
    pub bag_claim_ref: Option<ActionHash>,
    /// Wake tokens from the network's push relay, one for the store and
    /// one for the driver -- two, so the two can't tell they're the same
    /// person's. Sealed to each (docs/MOBILE.md); None without a relay.
    #[serde(default)]
    pub wake_for_store: Option<String>,
    #[serde(default)]
    pub wake_for_driver: Option<String>,
}

/// Once the store accepts a delivery, it's listed under its drop-off's cell
/// for drivers nearby to find (`matching::get_open_orders_near`) -- nothing
/// before the store's acceptance is ever discoverable. The listing links the
/// accepting version (validation checks it's Open).
pub(crate) fn publish_to_open_anchor(opened: &ActionHash, dropoff_geohash: &str, now: Timestamp) -> ExternResult<()> {
    let bucket = relay_types::time_bucket(now.as_millis(), OPEN_ORDER_BUCKET_MILLIS);
    create_link(open_order_anchor_path(dropoff_geohash, bucket)?.path_entry_hash()?, opened.clone(), LinkTypes::OpenOrderGeohashAnchor, ())?;
    Ok(())
}

/// The caller's own name, from their profile (where it's sealed to them);
/// empty if they haven't given one.
pub(crate) fn my_name() -> ExternResult<String> {
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "profiles", "get_my_name".into(), None, ())? else {
        return Err(guest("reading your name failed"));
    };
    Ok(io.decode::<Option<String>>().map_err(|e| wasm_error!(e))?.unwrap_or_default())
}

/// A note sealed to `recipient`, or `None` if there's nothing to say.
/// A wake token sealed to `recipient` -- the store, which hands it to the
/// push relay when the order changes.
pub(crate) fn seal_wake(recipient: &AgentPubKey, token: Option<&str>) -> ExternResult<Option<XSalsa20Poly1305EncryptedData>> {
    match token.map(str::trim).filter(|token| !token.is_empty()) {
        None => Ok(None),
        Some(token) => Ok(Some(seal(recipient, &checked_wake(token)?.to_string())?)),
    }
}

/// A wake token, if it's the size the relay makes them.
pub(crate) fn checked_wake(token: &str) -> ExternResult<&str> {
    if token.len() > MAX_WAKE_CHARS {
        return Err(guest(format!("a wake token is at most {MAX_WAKE_CHARS} characters")));
    }
    Ok(token)
}

const MAX_WAKE_CHARS: usize = 512;

pub(crate) fn seal_note(recipient: &AgentPubKey, note: &str) -> ExternResult<Option<XSalsa20Poly1305EncryptedData>> {
    let note = note.trim();
    if note.is_empty() {
        return Ok(None);
    }
    check_note(note)?;
    Ok(Some(seal(recipient, &note.to_string())?))
}

/// A note (for the kitchen, the driver, the store) within the longest a note
/// may be -- checked before it's sealed, as validation can only bound the
/// ciphertext.
pub(crate) fn check_note(note: &str) -> ExternResult<()> {
    let max = relay_integrity_support::limits::MAX_NOTE_CHARS;
    if note.chars().count() > max {
        return Err(guest(format!("a note may be at most {max} characters")));
    }
    Ok(())
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
        } else if is_current_driver(&order, &me)? {
            // The order's driver, once they've committed and the customer's
            // app has shared it with them; anyone else gets None.
            match crate::deliveries::dropoff_share_for(&original_action_of(record.action_address().clone())?, &me)? {
                Some(share) => open(&order.requester, &share.sealed)?,
                None => None,
            }
        } else {
            None
        };
        // The store has its own copy; a driver has the one in their drop-off.
        let customer_name = match open_for_parties(&me, &order.requester, &order.merchant, order.sealed_customer_name.as_ref())? {
            Some(name) => Some(name),
            None => dropoff.as_ref().map(|d| d.recipient.clone()).filter(|name| !name.is_empty()),
        };
        let kitchen_note = open_for_parties(&me, &order.requester, &order.merchant, order.kitchen_note.as_ref())?;
        // The wake token is for the driver's conductor to hand on, not a
        // detail to show.
        let dropoff = dropoff.map(|dropoff| DropoffDetails { wake: None, ..dropoff });
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

/// Whether `agent` is the driver behind the order's accepted bid.
fn is_current_driver(order: &DeliveryOrder, agent: &AgentPubKey) -> ExternResult<bool> {
    let Some(bid_ref) = &order.accepted_bid else { return Ok(false) };
    Ok(decode_or::<Bid>(&resolve_latest(bid_ref.clone())?).is_some_and(|bid| &bid.bidder == agent))
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
            let refuse = |reason: &str| Err(guest(reason));
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
                return Err(guest("The store hasn't confirmed this goodie bag yet."));
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
    if input.order_total == 0 {
        return Err(guest("A free order can't be delivered: your driver answers for what they carry. Choose pickup instead."));
    }
    if !input.dropoff.is_valid() {
        return Err(guest("That drop-off isn't a real place."));
    }
    check_note(&input.dropoff_notes)?;
    let dropoff_geohash = relay_types::encode(input.dropoff, DROPOFF_GEOHASH_PRECISION);
    let status = if input.requested_delivery_time.is_some() { DeliveryStatus::Scheduled } else { DeliveryStatus::Placed };

    if let Some(promo_ref) = &input.promo_code_ref {
        ensure_promo_usable(promo_ref, &input.catalog_ref)?;
    }
    if let Some(claim_ref) = &input.bag_claim_ref {
        ensure_claim_confirmed(claim_ref)?;
    }
    order_queues::ensure_order_rate()?;

    let merchant = input.merchant.clone();

    // The store as it is now: its delivery radius (a pre-check -- see
    // `ensure_promo_active` for why current settings can't be validated)
    // and its share of the delivery fee, which this order records as the
    // split it was placed under.
    let (catalog_version, catalog) = current_catalog_version(&input.catalog_ref)?;
    let priced = price_order(&input.catalog_ref, &catalog, &input.items, input.promo_code_ref.as_ref(), input.bag_claim_ref.as_ref(), input.order_total)?;
    ensure_store_minimum(&catalog, &priced)?;
    crate::pricing::ensure_age_rules(&priced, true, false)?;
    let distance = relay_types::distance_km(catalog.location, input.dropoff);
    if distance > catalog.max_delivery_radius_km {
        return Err(guest(format!(
            "dropoff is {:.1}km away, past this store's {:.1}km delivery radius",
            distance, catalog.max_delivery_radius_km
        )));
    }
    // Open when it's for -- now, or a scheduled order's time. A goodie bag
    // runs on its own pickup window, which the store set.
    if input.bag_claim_ref.is_none() {
        let wanted_at = input.requested_delivery_time.unwrap_or(now).as_micros();
        if let Some(reason) = closed_reason(&catalog, wanted_at) {
            return Err(guest(reason));
        }
    }

    let customer_name = my_name()?;
    // Every delivery gets a PIN; whether the driver must collect it is the
    // store's call, when it accepts (see `pin`).
    if input.dropoff_preference == DropoffPreference::LeaveAtDoor && !input.door_risk_accepted {
        return Err(guest("To have it left at your door, accept that it's delivered once it's left there."));
    }
    let code = crate::pin::new_code()?;
    let order = DeliveryOrder {
        requester: requester.clone(),
        merchant: merchant.clone(),
        catalog_ref: input.catalog_ref,
        catalog_version,
        lines: priced.lines,
        order_total: priced.order_total,
        tax_cents: priced.tax_cents,
        dropoff_geohash: dropoff_geohash.clone(),
        sealed_dropoff: seal(&requester, &DropoffDetails { point: input.dropoff, notes: input.dropoff_notes, recipient: customer_name.clone(), wake: input.wake_for_driver.as_deref().map(checked_wake).transpose()?.map(str::to_string) })?,
        kitchen_note: seal_note(&merchant, &input.kitchen_notes)?,
        sealed_customer_name: seal_note(&merchant, &customer_name)?,
        sealed_wake: seal_wake(&merchant, input.wake_for_store.as_deref())?,
        max_delivery_fee: input.max_delivery_fee,
        status,
        accepted_bid: None,
        delivery_receipts: Vec::new(),
        requested_at: now,
        tip_cents: input.tip_cents,
        delivery_subsidy_percent: catalog.delivery_subsidy_percent,
        requested_delivery_time: input.requested_delivery_time,
        promo_code_ref: input.promo_code_ref,
        dropoff_preference: input.dropoff_preference,
        door_risk_accepted: input.dropoff_preference == DropoffPreference::LeaveAtDoor,
        priority: input.priority,
        bag_claim_ref: input.bag_claim_ref,
        loyalty_proof: priced.loyalty_proof,
        cancellation: None,
        ready_by: None,
        food_hold: None,
        driver_pay_hold: None,
        subsidy_hold: None,
        collateral_hold: None,
        pin_commitment: code.commitment,
        sealed_pin: code.sealed,
        pickup_commitment: Vec::new(),
        sealed_pickup_code: None,
        pickup_proof: None,
        collection_proof: None,
        prep_minutes: None,
        collect_request: None,
        beacon: None,
        auto_match: input.auto_match,
    };
    let action_hash = create_entry(&EntryTypes::DeliveryOrder(order))?;
    // The food is paid for up front, in this same commit: the store can't
    // accept an order whose money isn't set aside.
    settlement::place_hold(&action_hash, HoldPurpose::Food)?;
    // The store finds it in its queue; drivers only once the store accepts
    // it (`accept_delivery_order`).
    order_queues::enqueue(&action_hash, &catalog_ref, &requester, now)?;
    // This conductor sends a scheduled order to the store when it's due,
    // and cancels one the store never answers -- see `upkeep`.
    upkeep::tend_my_orders_soon()?;

    written(action_hash)
}

/// The one narrow transition out of `Scheduled`: placing the order with its
/// store once its time arrives. The customer's conductor does this on its
/// own (`upkeep`); fails fast, as a convenience, if it's clearly too early
/// -- `validate_order_transition`'s check against this update's own
/// recorded timestamp is the real, deterministic enforcement.
#[hdk_extern]
pub fn open_scheduled_order(order_original_action: ActionHash) -> ExternResult<Record> {
    let (current, mut order): (_, DeliveryOrder) = resolve_version_decoded(order_original_action, "DeliveryOrder")?;
    if order.status != DeliveryStatus::Scheduled {
        return Err(guest("This order isn't scheduled."));
    }
    let now = sys_time()?;
    if let Some(due) = order.requested_delivery_time {
        if now < due {
            return Err(guest("It isn't time to send this order yet."));
        }
    }
    order.status = DeliveryStatus::Placed;
    let updated = update_version(&current, &EntryTypes::DeliveryOrder(order), LinkTypes::Version)?;
    upkeep::tend_my_orders_soon()?;
    written(updated)
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
    /// prep time if `None`. For a delivery it starts once a driver commits
    /// (`deliveries::start_cooking`); for a pickup, now.
    #[serde(default)]
    pub prep_minutes: Option<u16>,
}

#[hdk_extern]
pub fn accept_delivery_order(input: AcceptOrderInput) -> ExternResult<Record> {
    let order_original_action = input.order_original_action;
    let (current, mut order): (_, DeliveryOrder) = resolve_version_decoded(order_original_action.clone(), "DeliveryOrder")?;
    if order.status != DeliveryStatus::Placed {
        return Err(guest("This order has already been accepted or cancelled."));
    }
    if order.merchant != agent_info()?.agent_initial_pubkey {
        return Err(guest("Only the order's store can accept it."));
    }
    crate::accounts::ensure_not_moved(&order.requester, "This customer")?;
    ensure_priced_from_current_menu(&order_original_action, &order.lines, order.bag_claim_ref.as_ref(), order.promo_code_ref.as_ref())?;
    ensure_current_terms(&order_original_action, &order.catalog_ref, &order.catalog_version)?;
    if let Some(claim_ref) = &order.bag_claim_ref {
        crate::claims::redeem_bag_claim(claim_ref)?;
    }
    let original = original_action_of(order_original_action.clone())?;
    order.food_hold = settlement::required_hold(&original, HoldPurpose::Food, &order.requester, settlement::owes(&original, &HoldPurpose::Food, None)?)?;
    // A store checks its driver in by setting aside their whole fee (its
    // share, and the customer's again in case it keeps them waiting). It
    // must be able to: a store that can't would leave its driver unable to
    // check in, and answering for food it may have made.
    let float = order.max_delivery_fee.unwrap_or_else(|| relay_governance::suggested_delivery_fees().into_iter().max().unwrap_or(0));
    let spendable = crate::settlement::spendable()?;
    if spendable < i128::from(float) {
        return Err(guest(format!(
            "Your balance can't cover a driver's fee for this order (up to {float_cents}), which you set aside when you check them in. Add funds, then accept it.",
            float_cents = float
        )));
    }
    // The store's own limit on what may be left at a door.
    let limit = current_catalog(&order.catalog_ref)?.leave_at_door_max_cents;
    if order.dropoff_preference == DropoffPreference::LeaveAtDoor && limit.is_some_and(|max| order.order_total > max) {
        return Err(guest("This order is over your limit for leaving at the door -- decline it, or ask the customer to have it handed over."));
    }
    // The store's check-in code, for the driver collecting it.
    let code = crate::pin::new_code()?;
    order.pickup_commitment = code.commitment;
    order.sealed_pickup_code = Some(code.sealed);
    // The kitchen starts once a driver commits: the prep time is quoted now.
    order.prep_minutes = Some(crate::stores::prep_time(&order.catalog_ref, input.prep_minutes)?);
    order.status = DeliveryStatus::Open;
    let dropoff_geohash = order.dropoff_geohash.clone();
    let updated = update_version(&current, &EntryTypes::DeliveryOrder(order), LinkTypes::Version)?;
    publish_to_open_anchor(&updated, &dropoff_geohash, sys_time()?)?;
    written(updated)
}

/// Reads a specific, already-known order's current state -- every other
/// order-bearing extern here returns the order it just touched, but nothing
/// previously let a client re-fetch a *given* order later (a page reload, a
/// third party checking status the requester's own mutations wouldn't
/// surface, a driver polling their own accepted order). `resolve_latest`
/// is what makes this reflect the order's real current status rather than
/// its original `Open` creation record -- see the `get()`-on-`ActionHash`
/// literalness note in `docs/HOLOCHAIN_ISSUES.md` #4.
#[hdk_extern]
pub fn get_order(order_original_action: ActionHash) -> ExternResult<Record> {
    resolve_latest(order_original_action)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetOrderStatusInput {
    pub order_original_action: ActionHash,
    pub next_status: DeliveryStatus,
}

/// A step in a delivery, by the status it moves to -- each routed to the
/// function that does that step with what it needs (its hold, its proof):
/// the driver committing, the store cooking, the store checking the driver
/// in. Every other step has its own function, which says what it records.
#[hdk_extern]
pub fn set_order_status(input: SetOrderStatusInput) -> ExternResult<Record> {
    let order = input.order_original_action;
    match input.next_status {
        DeliveryStatus::DriverEnRouteToMerchant => crate::deliveries::commit_to_order(order),
        DeliveryStatus::MerchantConfirmed => crate::deliveries::start_cooking(order),
        DeliveryStatus::DriverAtStore => {
            let checked_in = crate::deliveries::ensure_checked_in(order)?;
            written(checked_in)
        }
        other => Err(guest(format!(
            "{other:?} is recorded by its own step: accept_delivery_order, accept_bid, drop_order, pick_up_order, complete_delivery, cancel_order or decline_order"
        ))),
    }
}

/// The rules this network runs by, as its DNA sets them. The app reads them
/// once while connecting, and every screen that quotes or applies one
/// (countdowns, limits, the policies page) reads it from there -- so none
/// can drift from what's enforced.
#[derive(Serialize, Deserialize, Debug)]
pub struct NetworkTerms {
    /// The ISO 4217 code every amount is in, in its minor units.
    pub currency: String,
    pub credit_limit_cents: u64,
    /// The least anyone may cash out at once.
    pub min_redemption_cents: u64,
    /// The delivery fee caps checkout suggests, in minor units.
    pub suggested_delivery_fees: Vec<u64>,
    pub store_response_secs: u64,
    /// The most orders a customer may place within one store response window.
    pub max_pending_orders: u32,
    /// How long a customer has to report items missing or wrong.
    pub report_window_secs: u64,
    /// However late a report comes, how long the store has to answer it.
    pub answer_grace_secs: u64,
    /// How long a customer's "never arrived" stands before the store's app
    /// decides it.
    pub claim_grace_secs: u64,
    /// How long past the store's ready time a driver has to be checked in
    /// before the store's app moves them on, and the customer may collect it.
    pub pickup_grace_secs: u64,
    /// How long a driver whose bid is accepted has to commit.
    pub offer_secs: u64,
    /// How long a checked-in driver waits past the ready time before they
    /// may call the store late, for a store that hasn't set its own -- and
    /// the bounds on a store's own.
    pub store_wait_secs: u64,
    pub min_store_wait_secs: u64,
    pub max_store_wait_secs: u64,
    /// How long an order a driver left cooking stays open to another.
    pub replacement_window_secs: u64,
    /// How long a customer's app collects bids before matching.
    pub bid_window_secs: u64,
    /// How many times an order may change drivers.
    pub max_driver_changes: u32,
    /// Different stores a driver must have delivered for before their
    /// check-in reports count.
    pub min_reporter_stores: u32,
    /// How far back ratings and records reach, in days.
    pub reputation_window_days: u32,
    /// What a minute of a driver's arrival time counts for when matching.
    pub minute_value_cents: u64,
    /// Where apps fetch the network's time source from.
    pub time_relays: Vec<String>,
    pub time_chain_hash: String,
    /// How long a customer collecting an order has to come for it.
    pub collection_window_secs: u64,
    /// Wrong handoff codes a giver's app answers per order before it stops.
    pub max_code_attempts: u32,
    pub default_prep_minutes: u16,
    pub max_prep_minutes: u16,
    pub max_delivery_radius_km: f64,
    /// The most orders a driver may carry at once.
    pub max_concurrent_deliveries: u32,
    /// How far from a driver's remaining drop-offs an add-on may go.
    pub add_on_detour_km: f64,
    /// The most an inline image may take, in bytes of its data URI.
    pub max_image_bytes: u64,
    pub goodie_bag_max_days: u64,
    /// How long a new goodie bag holds a confirmed claim, by default.
    pub default_bag_hold_minutes: u16,
    /// What listing a store sets aside, in minor units -- returned when it
    /// closes.
    pub store_listing_stake: u64,
    /// Whether a customer can appeal their store's settlement, and for how
    /// long after it -- none without arbiters.
    pub appeals: bool,
    pub appeal_window_secs: u64,
    /// Whether drivers are verified by the network's verifiers before they
    /// bid, and for how long a verification lasts.
    pub drivers_verified: bool,
    pub verification_days: u64,
    /// The age for age-restricted items, if the network sells any.
    pub restricted_min_age: Option<u8>,
    /// Map tiles, as a `{z}/{x}/{y}` template -- the network's choice.
    pub map_tiles_url: String,
    pub map_attribution: String,
    /// A Nominatim-compatible address search API.
    pub geocoder_url: String,
    /// The push relay that wakes a closed app, if the network runs one.
    pub push_relay_url: Option<String>,
}

#[hdk_extern]
pub fn get_network_terms(_: ()) -> ExternResult<NetworkTerms> {
    Ok(NetworkTerms {
        currency: relay_governance::currency(),
        credit_limit_cents: relay_governance::credit_limit_cents(),
        min_redemption_cents: relay_governance::min_redemption_cents(),
        suggested_delivery_fees: relay_governance::suggested_delivery_fees(),
        store_response_secs: relay_governance::store_response_window().as_secs(),
        max_pending_orders: relay_governance::max_pending_orders(),
        report_window_secs: relay_governance::report_window().as_secs(),
        answer_grace_secs: relay_governance::answer_grace().as_secs(),
        claim_grace_secs: relay_governance::claim_grace().as_secs(),
        pickup_grace_secs: relay_governance::pickup_grace().as_secs(),
        offer_secs: relay_governance::offer_window().as_secs(),
        store_wait_secs: relay_governance::store_wait().as_secs(),
        min_store_wait_secs: relay_governance::min_store_wait().as_secs(),
        max_store_wait_secs: relay_governance::max_store_wait().as_secs(),
        replacement_window_secs: relay_governance::replacement_window().as_secs(),
        bid_window_secs: relay_governance::bid_window().as_secs(),
        max_driver_changes: relay_governance::max_driver_changes(),
        min_reporter_stores: relay_governance::min_reporter_stores(),
        reputation_window_days: (relay_governance::reputation_window().as_secs() / 86_400) as u32,
        minute_value_cents: relay_governance::minute_value_cents(),
        time_relays: relay_governance::time_source().relays,
        time_chain_hash: relay_governance::time_source().chain_hash,
        collection_window_secs: relay_governance::collection_window().as_secs(),
        max_code_attempts: relay_governance::max_code_attempts(),
        default_prep_minutes: relay_governance::default_prep_minutes(),
        max_prep_minutes: relay_governance::max_prep_minutes(),
        max_delivery_radius_km: relay_governance::max_delivery_radius_km(),
        max_concurrent_deliveries: relay_governance::max_concurrent_deliveries(),
        add_on_detour_km: relay_governance::add_on_detour_km(),
        max_image_bytes: relay_governance::max_image_bytes() as u64,
        goodie_bag_max_days: relay_governance::goodie_bag_max_lifetime().as_secs() / 86_400,
        default_bag_hold_minutes: relay_governance::default_bag_hold_minutes(),
        store_listing_stake: relay_governance::store_listing_stake(),
        appeals: !relay_governance::arbiters().is_empty(),
        appeal_window_secs: relay_governance::appeal_window().as_secs(),
        drivers_verified: relay_governance::require_verified_drivers(),
        verification_days: relay_governance::verification_lifetime().as_secs() / 86_400,
        restricted_min_age: relay_governance::restricted_min_age(),
        map_tiles_url: relay_governance::services().map_tiles_url,
        map_attribution: relay_governance::services().map_attribution,
        geocoder_url: relay_governance::services().geocoder_url,
        push_relay_url: relay_governance::services().push_relay_url,
    })
}

/// The driver picking the order up, on the store's record of handing it to
/// them. Their app does it as soon as that record reaches it
/// (`deliveries::tend_driver_deliveries`).
#[hdk_extern]
pub fn pick_up_order(order_original_action: ActionHash) -> ExternResult<Record> {
    let (current, mut order): (_, DeliveryOrder) = resolve_version_decoded(order_original_action.clone(), "DeliveryOrder")?;
    if order.status != DeliveryStatus::DriverAtStore {
        return Err(guest("An order can be picked up only once the store has checked its driver in."));
    }
    let proof = call(CallTargetCell::Local, "attestation", "pickup_proof_for_order".into(), None, order_original_action.clone())?;
    let proof: Option<ActionHash> = match proof {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e))?,
        _ => None,
    };
    order.pickup_proof = Some(proof.ok_or(guest("Have the store scan your code, or confirm they've handed it over."))?);
    order.status = DeliveryStatus::PickedUp;
    let updated = update_version(&current, &EntryTypes::DeliveryOrder(order), LinkTypes::Version)?;
    written(updated)
}

/// The customer withdrawing their delivery, until a driver picks it up --
/// for a full refund if the store has kept a driver waiting
/// (`Cancellation::StoreLate`), else owing what's been started for them.
#[hdk_extern]
pub fn cancel_order(order_original_action: ActionHash) -> ExternResult<Record> {
    let latest = resolve_latest(order_original_action.clone())?;
    if let Some(version) = dispatch_integrity::lineage::Version::of(latest.clone()) {
        if dispatch_integrity::lineage::liable_release(&version)?.is_some() {
            return Err(guest("Your driver left your order while it was cooking, so they answer for it: wait for another driver (you're refunded in full if none comes), or collect it yourself."));
        }
    }
    let store_late = dispatch_integrity::lineage::Version::of(latest).map(|v| dispatch_integrity::lineage::store_was_late(&v)).transpose()?.unwrap_or(false);
    cancel_delivery(order_original_action, if store_late { Cancellation::StoreLate } else { Cancellation::ByCustomer })
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
    let (current, mut order): (_, DeliveryOrder) = resolve_version_decoded(order_original_action.clone(), "DeliveryOrder")?;
    order.status = DeliveryStatus::Cancelled;
    order.cancellation = Some(reason);
    let updated = update_version(&current, &EntryTypes::DeliveryOrder(order.clone()), LinkTypes::Version)?;
    order_queues::retire(&OrderParties::delivery(&order_original_action, &order)?)?;
    written(updated)
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
    pub(crate) basis: ActionHash,
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
    DeliveryDropped,
    StoreLate,
    CheckInRefused,
    OfferLapsed,
}

/// Best-effort reputation bookkeeping shared by every completion/dispute
/// path in this crate, resting on `basis` -- the order version or store
/// decision the event records (see `reputation_integrity::validate_event`).
/// Skips an event whose subject would be the caller
/// themselves -- `reputation_integrity::validate_event` rejects
/// subject == counterparty, which happens legitimately when a merchant
/// orders from their own store (see `settle_order_total`). That skip
/// matters beyond tidiness: even behind `let _`, a nested `call` whose
/// commit fails validation was observed to fail *this* call's whole commit
/// too (pinned by `pickup-self-order.test.ts`), so an event that's certain
/// to be rejected must never be attempted.
pub(crate) fn record_reputation_event(subject: &AgentPubKey, target: ReputationTargetWire, order_ref: ActionHash, kind: ReputationEventKindWire, basis: ActionHash) -> ExternResult<()> {
    if subject == &agent_info()?.agent_initial_pubkey {
        return Ok(());
    }
    let _ = call(CallTargetCell::Local, "reputation", "record_event".into(), None, RecordEventInputWire { target, order_ref, kind, basis });
    Ok(())
}


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
    let (order_record, mut order): (_, DeliveryOrder) = resolve_version_decoded(input.order_original_action.clone(), "DeliveryOrder")?;

    if !matches!(order.status, DeliveryStatus::PickedUp | DeliveryStatus::Disputed) {
        return Err(guest("An order can be completed only once it's picked up."));
    }
    if order.accepted_bid.is_none() {
        return Err(guest("This order has no driver yet."));
    }

    // Proof the customer has it -- see `attestation::delivery_proof_for_order`.
    let proof_response = call(CallTargetCell::Local, "attestation", "delivery_proof_for_order".into(), None, input.order_original_action.clone())?;
    let proof: Option<ActionHash> = match proof_response {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e))?,
        other => return Err(guest(format!("cannot complete this delivery yet: {other:?}"))),
    };
    let proof = proof.ok_or(guest("There's no proof yet that the customer has it: scan their code, or have them confirm."))?;

    let parties = OrderParties::delivery(&input.order_original_action, &order)?;
    let merchant = order.merchant.clone();
    let catalog_ref = order.catalog_ref.clone();
    order.status = DeliveryStatus::Delivered;
    order.delivery_receipts = vec![proof];
    let updated = update_version(&order_record, &EntryTypes::DeliveryOrder(order), LinkTypes::Version)?;
    order_queues::retire(&parties)?;
    // Nothing is paid here: the money was set aside as the order went. The
    // store's conductor decides the order delivered on this update, and
    // each party collects from their own (`settlement`), told by its signal.

    // Best-effort: reputation bumps are valuable but shouldn't block
    // delivery completion if they fail. One per role this order
    // actually involved -- the driver's completed delivery, and the store's
    // completed order -- each counted only toward its own target.
    // The store's completed order, recorded by whoever completed it, on the
    // version completing it. The driver's is the store's to record, on its
    // decision that it was delivered (`issues::decide_order`).
    record_reputation_event(&merchant, ReputationTargetWire::Store(catalog_ref), input.order_original_action.clone(), ReputationEventKindWire::OrderCompleted, updated.clone())?;

    written(updated)
}

