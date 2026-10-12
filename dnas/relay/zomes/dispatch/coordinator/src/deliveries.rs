//! A delivery from a driver's acceptance to their pickup, and what happens
//! when that goes wrong -- what DoorDash and Uber Eats smooth over from the
//! middle, done here by the order's own parties on rules every peer checks
//! (`dispatch_integrity::delivery`), with nobody paying for anyone else's
//! failure:
//!
//! - **The driver commits**, setting aside collateral of the food's value --
//!   their app does it as soon as their bid is accepted. A driver who
//!   doesn't within the network's offer window (`offer_window`, ~45s as on
//!   DoorDash) is moved on by the store's app.
//! - **The store cooks** once a driver has committed -- so an order no
//!   driver takes costs nobody anything -- and its app confirms each driver
//!   that commits.
//! - **The driver checks in** at the counter by scanning the store's code;
//!   the store's app records it, setting aside its share of their fee and,
//!   in case it keeps them waiting, the customer's share again.
//! - **The store hands it over** by scanning the driver's code; the
//!   driver's app picks it up on that record.
//!
//! When it goes wrong:
//!
//! - **A driver can't make it**: they drop it, any time before pickup. What
//!   was held for them goes back and it reopens to bids; it's on their
//!   record. A driver late to the store is moved on by the store's app the
//!   same way.
//! - **Hot potato**: a driver who leaves an order the store has started
//!   cooking answers for the food -- unless another driver takes it on, or
//!   the customer collects it. If none does within the network's window,
//!   the store's app ends it: the customer is refunded and that driver's
//!   collateral pays for the food (`Cancellation::NoDriver`).
//! - **The store keeps a driver waiting** past its wait (its own, part of
//!   the order's terms) after the ready time: the driver calls it late, with
//!   proof of the time, and leaves paid in full by the store
//!   (`lineage::is_store_late_release`). The order goes to another driver,
//!   and its customer may now cancel for a full refund
//!   (`Cancellation::StoreLate`).
//! - **The customer collects it themselves**, when no driver has it or its
//!   driver is late: they ask, the store's app records it, and the store
//!   refunds them its share of the fee it would have paid a driver.
//! - **A store that won't check a driver in**: the network can't tell, so
//!   it moves no money -- the driver reports it, and it shows on the store's
//!   record, for drivers choosing where to work.

use crate::order_queues::{retire, unqueue_driver, OrderParties};
use crate::orders::{publish_to_open_anchor, record_reputation_event, ReputationEventKindWire, ReputationTargetWire};
use crate::settlement::place_hold;
use crate::signals::RemoteSignal;
use dispatch_integrity::lineage::{self, Version};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, original_action_of, resolve_latest, resolve_latest_decoded};
use relay_types::Beacon;

fn guest(message: &str) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message.into()))
}

/// The order as it stands.
fn current(order_ref: &ActionHash) -> ExternResult<(Record, DeliveryOrder)> {
    resolve_latest_decoded(order_ref.clone(), "DeliveryOrder")
}

/// The driver behind the order's accepted bid.
fn driver_of(order: &DeliveryOrder) -> ExternResult<Option<(ActionHash, Bid)>> {
    let Some(bid_ref) = &order.accepted_bid else { return Ok(None) };
    Ok(resolve_latest(bid_ref.clone())?.entry().to_app_option::<Bid>().map_err(|e| wasm_error!(e))?.map(|bid| (bid_ref.clone(), bid)))
}

/// Writes `order` as the next version of `record`.
fn write(record: &Record, order: DeliveryOrder) -> ExternResult<Record> {
    let updated = update_entry(record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;
    get(updated, GetOptions::local())?.ok_or(guest("could not read back the order"))
}

fn me() -> ExternResult<AgentPubKey> {
    Ok(agent_info()?.agent_initial_pubkey)
}

/// The order without its driver: their address, and what was held for them.
fn without_driver(order: &mut DeliveryOrder) {
    order.accepted_bid = None;
    order.driver_pay_hold = None;
    order.collateral_hold = None;
    order.subsidy_hold = None;
}

// --- the driver commits ---

/// The driver committing to an order whose customer accepted their bid:
/// their collateral -- the food's value -- set aside in this same commit.
/// Their app does it as soon as it hears (`tend_my_deliveries`).
#[hdk_extern]
pub fn commit_to_order(order_ref: ActionHash) -> ExternResult<Record> {
    let order_ref = original_action_of(order_ref)?;
    let (record, mut order) = current(&order_ref)?;
    let Some((bid_ref, bid)) = driver_of(&order)? else { return Err(guest("this order has no driver")) };
    if bid.bidder != me()? {
        return Err(guest("Only the order's driver commits to it."));
    }
    if order.status != DeliveryStatus::BidAccepted {
        return Err(guest("You've already committed to this order."));
    }
    order.collateral_hold = place_hold(&order_ref, HoldPurpose::Collateral { bid: bid_ref })?;
    order.status = DeliveryStatus::DriverEnRouteToMerchant;
    write(&record, order)
}

// --- the customer shares their address ---

/// The customer's app sharing their exact drop-off with a driver who's
/// committed -- sealed to that driver alone. Done as soon as it hears they
/// have (`upkeep`), never before: a driver with nothing at stake never
/// learns where anyone lives.
#[hdk_extern]
pub fn share_address(order_ref: ActionHash) -> ExternResult<ActionHash> {
    let order_ref = original_action_of(order_ref)?;
    let (record, order) = current(&order_ref)?;
    let me = me()?;
    if order.requester != me {
        return Err(guest("Only the order's customer shares its address."));
    }
    let Some(driver) = owed_driver(&order_ref, &order)? else { return Err(guest("There's no committed driver waiting for the address.")) };
    let dropoff: DropoffDetails = relay_coordinator_support::open(&me, &order.sealed_dropoff)?.ok_or(guest("couldn't open your address"))?;
    let share = DropoffShare { order: order_ref.clone(), committed: record.action_address().clone(), sealed: relay_coordinator_support::seal(&driver, &dropoff)?, driver: driver.clone() };
    let action = create_entry(&EntryTypes::DropoffShare(share))?;
    create_link(order_ref, action.clone(), LinkTypes::OrderToDropoffShare, driver.get_raw_39().to_vec())?;
    Ok(action)
}

/// The committed driver the customer's app owes the address, if any: the
/// order's driver, committed, with no share for them yet.
pub(crate) fn owed_driver(order_ref: &ActionHash, order: &DeliveryOrder) -> ExternResult<Option<AgentPubKey>> {
    let active = matches!(order.status, DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed | DeliveryStatus::DriverAtStore | DeliveryStatus::PickedUp);
    if !active || order.collateral_hold.is_none() {
        return Ok(None);
    }
    let Some((_, bid)) = driver_of(order)? else { return Ok(None) };
    Ok(dropoff_share_for(order_ref, &bid.bidder)?.is_none().then_some(bid.bidder))
}

/// The address the customer shared with `driver` for an order, if they have.
pub(crate) fn dropoff_share_for(order_ref: &ActionHash, driver: &AgentPubKey) -> ExternResult<Option<DropoffShare>> {
    let mut query = LinkQuery::try_new(order_ref.clone(), LinkTypes::OrderToDropoffShare)?;
    query.tag_prefix = Some(LinkTag::new(driver.get_raw_39().to_vec()));
    for link in get_links(query, GetStrategy::default())? {
        let Some(target) = link.target.into_action_hash() else { continue };
        let share = get(target, GetOptions::default())?.and_then(|record| relay_coordinator_support::decode_or::<DropoffShare>(&record));
        if let Some(share) = share.filter(|s| &s.order == order_ref && &s.driver == driver) {
            return Ok(Some(share));
        }
    }
    Ok(None)
}

// --- the store cooks, and checks the driver in ---

/// The store starting on an order its driver has committed to -- or, if
/// it's already cooking for an earlier driver, confirming this one. Its app
/// does it as soon as the driver commits (`tend_store_deliveries`).
#[hdk_extern]
pub fn start_cooking(order_ref: ActionHash) -> ExternResult<Record> {
    let order_ref = original_action_of(order_ref)?;
    let (record, mut order) = current(&order_ref)?;
    if order.merchant != me()? {
        return Err(guest("Only the order's store cooks it."));
    }
    if order.status != DeliveryStatus::DriverEnRouteToMerchant {
        return Err(guest("This order isn't waiting on the kitchen."));
    }
    if order.ready_by.is_none() {
        order.ready_by = Some(ready_in(order.prep_minutes)?);
    }
    order.status = DeliveryStatus::MerchantConfirmed;
    write(&record, order)
}

/// When an order the store starts now will be ready, by the prep time it
/// quoted when it accepted the order.
fn ready_in(prep_minutes: Option<u16>) -> ExternResult<Timestamp> {
    let prep = prep_minutes.ok_or(guest("this order has no prep time"))?;
    Ok(Timestamp::from_micros(sys_time()?.as_micros() + i64::from(prep) * 60 * 1_000_000))
}

/// The store checking its driver in at the counter -- on their code
/// (`attestation::confirm_check_in`), or as it hands the order over
/// (`attestation::acknowledge_leg`), whichever comes first. It sets aside
/// its share of their fee, and what it owes them if it keeps them waiting.
/// Starts cooking first if it somehow hadn't. Idempotent: an order already
/// checked in is returned as it is.
#[hdk_extern]
pub fn ensure_checked_in(order_ref: ActionHash) -> ExternResult<ActionHash> {
    let order_ref = original_action_of(order_ref)?;
    let (record, order) = current(&order_ref)?;
    if order.merchant != me()? {
        return Err(guest("Only the order's store checks its driver in."));
    }
    let (record, mut order) = match order.status {
        DeliveryStatus::DriverAtStore => return Ok(record.action_address().clone()),
        DeliveryStatus::DriverEnRouteToMerchant => {
            let cooking = start_cooking(order_ref.clone())?;
            let order = decode_or::<DeliveryOrder>(&cooking).ok_or(guest("could not read back the order"))?;
            (cooking, order)
        }
        DeliveryStatus::MerchantConfirmed => (record, order),
        _ => return Err(guest("This order has no driver on their way to collect it.")),
    };
    let bid = order.accepted_bid.clone().ok_or(guest("this order has no driver"))?;
    order.subsidy_hold = place_hold(&order_ref, HoldPurpose::Subsidy { bid })?;
    order.status = DeliveryStatus::DriverAtStore;
    Ok(write(&record, order)?.action_address().clone())
}

/// Tells the order's driver the store has handed it over -- called by
/// `attestation::acknowledge_leg`, on the store's conductor. Their app picks
/// it up on that record.
#[hdk_extern]
pub fn notify_handed_over(order_ref: ActionHash) -> ExternResult<()> {
    let (_, order) = current(&order_ref)?;
    if order.merchant != me()? {
        return Ok(());
    }
    if let Some((_, bid)) = driver_of(&order)? {
        send_remote_signal(RemoteSignal::HandedOver { order_hash: order_ref }, vec![bid.bidder])?;
    }
    Ok(())
}

// --- leaving ---

#[derive(Serialize, Deserialize, Debug)]
pub struct DropOrderInput {
    pub order_ref: ActionHash,
    /// The current round of the network's time source: when they left, for
    /// the window another driver has to take it on.
    pub beacon: Beacon,
}

/// A driver dropping an order before they've picked it up. What was held
/// for them goes back and it opens to bids again; if the store had started
/// cooking it, they answer for the food until another driver takes it on or
/// its customer collects it.
#[hdk_extern]
pub fn drop_order(input: DropOrderInput) -> ExternResult<Record> {
    let order_ref = original_action_of(input.order_ref)?;
    let (record, mut order) = current(&order_ref)?;
    let Some((_, bid)) = driver_of(&order)? else { return Err(guest("This order has no driver.")) };
    if bid.bidder != me()? {
        return Err(guest("Only the order's driver can drop it."));
    }
    if !matches!(order.status, DeliveryStatus::BidAccepted | DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed | DeliveryStatus::DriverAtStore) {
        return Err(guest("An order can be dropped only before it's picked up."));
    }
    without_driver(&mut order);
    order.status = DeliveryStatus::Open;
    order.beacon = Some(input.beacon);
    reopen(&record, order)
}

/// Writes `order` reopened to bids, and publishes it where drivers look.
/// The customer's app takes it off the driver's queue on seeing it
/// (`record_what_changed`): only the customer edits that queue.
fn reopen(record: &Record, order: DeliveryOrder) -> ExternResult<Record> {
    let geohash = order.dropoff_geohash.clone();
    let reopened = write(record, order)?;
    publish_to_open_anchor(reopened.action_address(), &geohash, sys_time()?)?;
    Ok(reopened)
}

/// A store step whose deadline may need proving.
#[derive(Serialize, Deserialize, Debug)]
pub struct TimedStepInput {
    pub order_ref: ActionHash,
    /// The current round of the network's time source -- needed where
    /// claiming the deadline early would cost someone else: moving on a
    /// driver who's committed, ending an order for want of a driver,
    /// keeping the food of a customer who never came.
    #[serde(default)]
    pub beacon: Option<Beacon>,
}

/// Whether `deadline` has passed: by `beacon` where it must be proved, by
/// the caller's clock where it's their word.
fn past(deadline: Timestamp, proved: bool, beacon: Option<&Beacon>) -> ExternResult<bool> {
    if proved {
        return Ok(relay_integrity_support::beacon::proves_past(beacon, deadline).is_ok());
    }
    Ok(sys_time()? >= deadline)
}

/// The store moving a driver on -- one who hasn't committed within the
/// offer window, or isn't checked in by when they were due -- reopening the
/// order to bids. Its conductor moves on a driver who never committed; one
/// who did is moved on by its app, with proof of the time
/// (`get_store_steps_due`).
#[hdk_extern]
pub fn move_driver_on(input: TimedStepInput) -> ExternResult<Record> {
    let order_ref = original_action_of(input.order_ref)?;
    let (record, mut order) = current(&order_ref)?;
    if order.merchant != me()? {
        return Err(guest("Only the order's store moves its driver on."));
    }
    let Some((bid_ref, bid)) = driver_of(&order)? else { return Err(guest("This order has no driver.")) };
    let committed = order.collateral_hold.is_some();
    match driver_due(&record, &order, &bid)? {
        Some(due) if past(due, committed, input.beacon.as_ref())? => {}
        _ => return Err(guest("This driver still has time.")),
    }
    without_driver(&mut order);
    order.status = DeliveryStatus::Open;
    if committed {
        order.beacon = input.beacon;
    }
    let reopened = reopen(&record, order)?;
    let _ = send_remote_signal(RemoteSignal::BidReleased { bid_hash: bid_ref }, vec![bid.bidder]);
    Ok(reopened)
}

/// When the order's driver is out of time: the end of their offer window if
/// they haven't committed, when they're due at the store if they have.
/// `None` once they're checked in -- they're there.
fn driver_due(record: &Record, order: &DeliveryOrder, bid: &Bid) -> ExternResult<Option<Timestamp>> {
    let Some(version) = Version::of(record.clone()) else { return Ok(None) };
    Ok(match order.status {
        DeliveryStatus::BidAccepted => Some(lineage::offer_ends(&version)),
        DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed => lineage::due_at_store(&version, bid)?,
        _ => None,
    })
}

// --- the store late ---

#[derive(Serialize, Deserialize, Debug)]
pub struct StoreLateInput {
    pub order_ref: ActionHash,
    /// The current round of the network's time source -- proof the store's
    /// wait has passed.
    pub beacon: Beacon,
}

/// A checked-in driver calling the store late, once it's kept them waiting
/// past its wait: they leave paid in full by the store, with their
/// collateral, and the order opens to another driver. Its customer may now
/// cancel for a full refund. It's on the store's record.
#[hdk_extern]
pub fn call_store_late(input: StoreLateInput) -> ExternResult<Record> {
    let order_ref = original_action_of(input.order_ref)?;
    let (record, mut order) = current(&order_ref)?;
    let Some((_, bid)) = driver_of(&order)? else { return Err(guest("This order has no driver.")) };
    if bid.bidder != me()? || order.status != DeliveryStatus::DriverAtStore {
        return Err(guest("Only the driver the store checked in can call it late."));
    }
    let at_store = Version::of(record.clone()).ok_or(guest("not a delivery"))?;
    if relay_integrity_support::beacon::proves_past(Some(&input.beacon), lineage::store_late_after(&at_store)?).is_err() {
        return Err(guest("The store still has time: it's not late yet."));
    }
    let (merchant, catalog_ref) = (order.merchant.clone(), order.catalog_ref.clone());
    without_driver(&mut order);
    order.status = DeliveryStatus::Open;
    order.beacon = Some(input.beacon);
    let released = reopen(&record, order)?;
    let _ = record_reputation_event(&merchant, ReputationTargetWire::Store(catalog_ref), order_ref, ReputationEventKindWire::StoreLate, released.action_address().clone());
    Ok(released)
}

/// A driver reporting that the store wouldn't check them in. The network
/// can't check it, so it moves no money: it shows on the store's record.
/// Only a driver the order's customer accepted can report it, once.
#[hdk_extern]
pub fn report_check_in_refused(order_ref: ActionHash) -> ExternResult<()> {
    let order_ref = original_action_of(order_ref)?;
    let me = me()?;
    let (latest, order) = current(&order_ref)?;
    // A version naming them: the current one, or the one they left on.
    let basis = lineage::find_back(Version::of(latest).ok_or(guest("not a delivery"))?, |v, p| {
        let names_me = |o: &DeliveryOrder| driver_of(o).ok().flatten().is_some_and(|(_, bid)| bid.bidder == me);
        (names_me(&v.order) || p.is_some_and(|p| v.released(p).is_some() && names_me(&p.order))).then(|| v.record.action_address().clone())
    })?;
    let basis = basis.ok_or(guest("Only a driver on this order can report its store."))?;
    record_reputation_event(&order.merchant, ReputationTargetWire::Store(order.catalog_ref), order_ref, ReputationEventKindWire::CheckInRefused, basis)
}

// --- collecting it yourself ---

/// The customer asking to collect their delivery from the store themselves
/// -- when no driver has it, or its driver is late. The store's app records
/// it (`record_collecting`) as soon as it's allowed; its share of the fee it
/// would have paid a driver comes back to them.
#[hdk_extern]
pub fn request_collect(order_ref: ActionHash) -> ExternResult<ActionHash> {
    let order_ref = original_action_of(order_ref)?;
    let (_, order) = current(&order_ref)?;
    if order.requester != me()? {
        return Err(guest("Only the order's customer can collect it."));
    }
    if let Some(existing) = collect_request_of(&order_ref, &order.requester)? {
        return Ok(existing);
    }
    if !matches!(order.status, DeliveryStatus::Open | DeliveryStatus::BidAccepted | DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed) {
        return Err(guest("This order can't be switched to collecting now."));
    }
    let request = create_entry(&EntryTypes::CollectRequest(CollectRequest { order: order_ref.clone() }))?;
    create_link(order_ref.clone(), request.clone(), LinkTypes::OrderToCollectRequest, ())?;
    let _ = send_remote_signal(RemoteSignal::CollectRequested { order_hash: order_ref }, vec![order.merchant]);
    Ok(request)
}

/// The customer's request to collect `order`, if they've made one.
pub(crate) fn collect_request_of(order: &ActionHash, requester: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
    for link in get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToCollectRequest)?, GetStrategy::default())? {
        if &link.author == requester {
            return Ok(link.target.into_action_hash());
        }
    }
    Ok(None)
}

/// The store recording its customer's request to collect: the order leaves
/// its driver (moved on, as if late) and waits at the counter for them. Its
/// app does it as soon as it's allowed (`tend_store_deliveries`).
#[hdk_extern]
pub fn record_collecting(input: TimedStepInput) -> ExternResult<Record> {
    let order_ref = original_action_of(input.order_ref)?;
    let (record, mut order) = current(&order_ref)?;
    if order.merchant != me()? {
        return Err(guest("Only the order's store records it collecting."));
    }
    let request = collect_request_of(&order_ref, &order.requester)?.ok_or(guest("The customer hasn't asked to collect it."))?;
    let committed = order.collateral_hold.is_some();
    let released = match driver_of(&order)? {
        Some((bid_ref, bid)) => {
            match driver_due(&record, &order, &bid)? {
                Some(due) if past(due, committed, input.beacon.as_ref())? => {}
                _ => return Err(guest("The driver still has time; the customer can collect it if they're late.")),
            }
            Some((bid_ref, bid.bidder))
        }
        None => None,
    };
    if committed {
        order.beacon = input.beacon;
    }
    if order.ready_by.is_none() {
        order.ready_by = Some(ready_in(order.prep_minutes)?);
    }
    without_driver(&mut order);
    order.status = DeliveryStatus::Collecting;
    order.collect_request = Some(request);
    let collecting = write(&record, order)?;
    if let Some((bid_ref, driver)) = released {
        let _ = send_remote_signal(RemoteSignal::BidReleased { bid_hash: bid_ref }, vec![driver]);
    }
    Ok(collecting)
}

/// The customer confirming they've collected it.
#[hdk_extern]
pub fn confirm_collected(order_ref: ActionHash) -> ExternResult<Record> {
    collected(order_ref, None)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HandOverInput {
    pub order_original_action: ActionHash,
    /// The customer's handover code, as the store scanned it.
    pub code: PinSecret,
}

/// The store handing the order over at its counter, against the customer's
/// code.
#[hdk_extern]
pub fn hand_over_collection(input: HandOverInput) -> ExternResult<Record> {
    collected(input.order_original_action, Some(input.code))
}

fn collected(order_ref: ActionHash, code: Option<PinSecret>) -> ExternResult<Record> {
    let order_ref = original_action_of(order_ref)?;
    let (record, mut order) = current(&order_ref)?;
    let me = me()?;
    let by_store = code.is_some();
    let allowed = if by_store { order.merchant == me } else { order.requester == me };
    if !allowed || order.status != DeliveryStatus::Collecting {
        return Err(guest(if by_store { "Only the store hands over an order its customer is collecting." } else { "Only the customer confirms they've collected it." }));
    }
    if let Some(code) = &code {
        if !code.opens(&order.pin_commitment) {
            return Err(guest("That isn't this customer's code."));
        }
    }
    order.status = DeliveryStatus::Collected;
    order.collection_proof = code;
    let done = write(&record, order.clone())?;
    retire(&OrderParties::delivery(&order_ref, &order)?)?;
    // The customer has it, so the store's order is complete -- credited by
    // the customer; when the store handed it over, the customer's app
    // records it on seeing so (`record_what_changed`).
    if !by_store {
        let _ = record_reputation_event(&order.merchant, ReputationTargetWire::Store(order.catalog_ref.clone()), order_ref, ReputationEventKindWire::OrderCompleted, done.action_address().clone());
    }
    Ok(done)
}

/// The store recording an order its customer never came for, once the
/// collection window has passed: it keeps the food's price.
#[hdk_extern]
pub fn mark_not_collected(input: TimedStepInput) -> ExternResult<Record> {
    let order_ref = original_action_of(input.order_ref)?;
    let (record, order) = current(&order_ref)?;
    if order.merchant != me()? || order.status != DeliveryStatus::Collecting {
        return Err(guest("Only the store records an order it was waiting to hand over as uncollected."));
    }
    let window_ends = Timestamp::from_micros(record.action().timestamp().as_micros().saturating_add(relay_governance::collection_window().as_micros() as i64));
    if !past(window_ends, true, input.beacon.as_ref())? {
        return Err(guest("The customer still has time to collect it."));
    }
    cancel_proved(&record, order, &order_ref, Cancellation::NotCollected, input.beacon)
}

/// Cancels a delivery for `reason`, with the proof of the time it needs.
fn cancel_proved(record: &Record, mut order: DeliveryOrder, order_ref: &ActionHash, reason: Cancellation, beacon: Option<Beacon>) -> ExternResult<Record> {
    order.status = DeliveryStatus::Cancelled;
    order.cancellation = Some(reason);
    order.beacon = beacon;
    let cancelled = write(record, order.clone())?;
    retire(&OrderParties::delivery(order_ref, &order)?)?;
    Ok(cancelled)
}

// --- no driver came ---

/// When the store may end an order no driver came for: the network's
/// window after the driver who left it cooking. `None` if no driver answers
/// for it.
fn no_driver_after(record: &Record) -> ExternResult<Option<Timestamp>> {
    let Some(version) = Version::of(record.clone()) else { return Ok(None) };
    if version.order.status != DeliveryStatus::Open {
        return Ok(None);
    }
    let Some((release, _)) = lineage::liable_release(&version)? else { return Ok(None) };
    let left_at = lineage::release_time(&release, |b| relay_integrity_support::beacon::beacon_time(b).ok())?;
    Ok(left_at.map(|at| Timestamp::from_micros(at.as_micros().saturating_add(relay_governance::replacement_window().as_micros() as i64))))
}

/// The store ending an order no driver came for: the customer is refunded,
/// and the driver who left it cooking pays for the food. Its app does it
/// when the window's passed (`tend_store_deliveries`).
#[hdk_extern]
pub fn end_for_no_driver(input: TimedStepInput) -> ExternResult<Record> {
    let order_ref = original_action_of(input.order_ref)?;
    let (record, order) = current(&order_ref)?;
    if order.merchant != me()? {
        return Err(guest("Only the order's store ends it."));
    }
    match no_driver_after(&record)? {
        Some(after) if past(after, true, input.beacon.as_ref())? => {}
        Some(_) => return Err(guest("Another driver still has time to take it.")),
        None => return Err(guest("No driver left this order cooking.")),
    }
    cancel_proved(&record, order, &order_ref, Cancellation::NoDriver, input.beacon)
}

// --- timing, for screens ---

/// The deadlines an order is running against, for its screens. Each is
/// `None` where it doesn't apply.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct OrderTiming {
    /// When the accepted driver must have committed by.
    pub offer_ends: Option<Timestamp>,
    /// When the driver is due at the store -- after which the store's app
    /// moves them on, and the customer may collect it.
    pub driver_due: Option<Timestamp>,
    /// When the checked-in driver may call the store late.
    pub store_late_after: Option<Timestamp>,
    /// Whether a driver has called the store late on this order: its
    /// customer may cancel for a full refund.
    pub store_was_late: bool,
    /// When the store's app ends an order no driver came for.
    pub no_driver_after: Option<Timestamp>,
    /// When a customer collecting it must come by.
    pub collect_by: Option<Timestamp>,
    /// Whether its customer may ask to collect it now.
    pub can_collect: bool,
    /// Whether its customer has asked to.
    pub collect_requested: bool,
}

#[hdk_extern]
pub fn get_order_timing(order_ref: ActionHash) -> ExternResult<OrderTiming> {
    let order_ref = original_action_of(order_ref)?;
    let (record, order) = current(&order_ref)?;
    let mut timing = OrderTiming { collect_requested: collect_request_of(&order_ref, &order.requester)?.is_some(), ..Default::default() };
    let now = sys_time()?;
    let driver = driver_of(&order)?;
    match order.status {
        DeliveryStatus::BidAccepted => timing.offer_ends = driver.as_ref().and_then(|_| Version::of(record.clone()).map(|v| lineage::offer_ends(&v))),
        DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed => {
            if let Some((_, bid)) = &driver {
                timing.driver_due = driver_due(&record, &order, bid)?;
            }
        }
        DeliveryStatus::DriverAtStore => {
            timing.store_late_after = Version::of(record.clone()).map(|v| lineage::store_late_after(&v)).transpose()?;
        }
        DeliveryStatus::Open => timing.no_driver_after = no_driver_after(&record)?,
        DeliveryStatus::Collecting => {
            timing.collect_by = Some(Timestamp::from_micros(record.action().timestamp().as_micros().saturating_add(relay_governance::collection_window().as_micros() as i64)));
        }
        _ => {}
    }
    let driver_late = match (&driver, order.status.clone()) {
        (None, DeliveryStatus::Open) => true,
        (Some((_, bid)), DeliveryStatus::BidAccepted | DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed) => driver_due(&record, &order, bid)?.is_some_and(|due| now >= due),
        _ => false,
    };
    timing.can_collect = driver_late && !timing.collect_requested;
    timing.store_was_late = Version::of(record).map(|v| lineage::store_was_late(&v)).transpose()?.unwrap_or(false);
    Ok(timing)
}

// --- what the store's app does ---

/// What a store's deliveries call for once a deadline has passed -- the
/// steps its app takes, with proof of the time (`get_store_steps_due`).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreStep {
    /// Move on a committed driver who's late.
    MoveDriverOn,
    /// Record the customer collecting it, moving on their late driver.
    RecordCollecting,
    /// End an order no driver came for.
    EndForNoDriver,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct StoreStepDue {
    pub order: ActionHash,
    pub step: StoreStep,
    /// When it fell due.
    pub due: Timestamp,
}

/// One of the caller's stores' deliveries, as far as its deadlines go: the
/// step it calls for, and when -- whether it needs proof of the time.
fn next_store_step(order_ref: &ActionHash, record: &Record, order: &DeliveryOrder) -> ExternResult<Option<(StoreStep, Timestamp, bool)>> {
    let driver = driver_of(order)?;
    let driver_due = match &driver {
        Some((_, bid)) => driver_due(record, order, bid)?,
        None => None,
    };
    let committed = order.collateral_hold.is_some();
    let waiting = matches!(order.status, DeliveryStatus::Open | DeliveryStatus::BidAccepted | DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed);
    if waiting && order.collect_request.is_none() && collect_request_of(order_ref, &order.requester)?.is_some() {
        return Ok(match (driver.is_some(), driver_due) {
            (false, _) => Some((StoreStep::RecordCollecting, record.action().timestamp(), false)),
            (true, Some(due)) => Some((StoreStep::RecordCollecting, due, committed)),
            (true, None) => None,
        });
    }
    Ok(match order.status {
        DeliveryStatus::BidAccepted | DeliveryStatus::MerchantConfirmed | DeliveryStatus::DriverEnRouteToMerchant => driver_due.map(|due| (StoreStep::MoveDriverOn, due, committed)),
        DeliveryStatus::Open => no_driver_after(record)?.map(|after| (StoreStep::EndForNoDriver, after, true)),
        _ => None,
    })
}

/// The steps the caller's stores' deliveries call for now that need proof
/// of the time -- the store's app takes each with the time source's current
/// round. (Its conductor takes the rest on its own, but can't reach the
/// time source.)
#[hdk_extern]
pub fn get_store_steps_due(_: ()) -> ExternResult<Vec<StoreStepDue>> {
    let now = sys_time()?;
    let mut due = Vec::new();
    for store in crate::stores::my_stores()? {
        for entry in crate::order_queues::get_active_orders_for_store(store)? {
            let Some(order) = decode_or::<DeliveryOrder>(&entry.record) else { continue };
            if let Ok(Some((step, at, true))) = next_store_step(&entry.original_action, &entry.record, &order) {
                if now >= at {
                    due.push(StoreStepDue { order: entry.original_action.clone(), step, due: at });
                }
            }
        }
    }
    Ok(due)
}

/// Tends one of the caller's stores' deliveries from its conductor:
/// confirms a committed driver, and takes each step that falls due that's
/// the store's word -- moving on a driver who never committed, recording a
/// customer collecting an order no driver has -- in a zome call of its own,
/// so one that doesn't validate yet never undoes another. Steps that need
/// proof of the time are its app's (`get_store_steps_due`). Returns when
/// it next needs tending, if it will.
pub(crate) fn tend_store_delivery(order_ref: &ActionHash, record: &Record, order: &DeliveryOrder, now: Timestamp) -> ExternResult<Option<Timestamp>> {
    if order.status == DeliveryStatus::DriverEnRouteToMerchant {
        call_own("start_cooking", order_ref);
        return Ok(Some(Timestamp::from_micros(now.as_micros().saturating_add(1_000_000))));
    }
    let Some((step, due, proved)) = next_store_step(order_ref, record, order)? else { return Ok(None) };
    if proved {
        return Ok(None);
    }
    if now < due {
        return Ok(Some(due));
    }
    let function = match step {
        StoreStep::MoveDriverOn => "move_driver_on",
        StoreStep::RecordCollecting => "record_collecting",
        StoreStep::EndForNoDriver => return Ok(None),
    };
    call_own(function, &TimedStepInput { order_ref: order_ref.clone(), beacon: None });
    Ok(None)
}

// --- what the driver's app does ---

/// Tends the caller's deliveries as a driver: commits to each one whose
/// customer just accepted their bid, and picks up each one the store has
/// handed over. Returns how many it moved on.
pub(crate) fn tend_driver_deliveries() -> ExternResult<u32> {
    let mut moved = 0;
    for delivery in crate::order_queues::get_my_active_deliveries(())? {
        let Some(order) = decode_or::<DeliveryOrder>(&delivery.order.record) else { continue };
        let order_ref = delivery.order.original_action.clone();
        let step = match order.status {
            DeliveryStatus::BidAccepted => call_own("commit_to_order", &order_ref),
            DeliveryStatus::DriverAtStore => {
                // Handed over: the store's record of it has reached us.
                let handed_over = matches!(call(CallTargetCell::Local, "attestation", "pickup_proof_for_order".into(), None, order_ref.clone())?, ZomeCallResponse::Ok(io) if io.decode::<Option<ActionHash>>().ok().flatten().is_some());
                if !handed_over {
                    continue;
                }
                call_own("pick_up_order", &order_ref)
            }
            _ => continue,
        };
        if step {
            moved += 1;
        }
    }
    Ok(moved)
}

/// Calls one of this zome's externs in a call of its own, so one that
/// doesn't validate yet never undoes another. Whether it succeeded.
fn call_own<I: Serialize + std::fmt::Debug>(function: &str, input: &I) -> bool {
    let Ok(zome) = zome_info().map(|z| z.name) else { return false };
    matches!(call(CallTargetCell::Local, zome, function.into(), None, input), Ok(ZomeCallResponse::Ok(_)))
}

// --- what a customer's app records ---

/// A delivery its driver dropped, recorded against them by its customer, on
/// the version that released them.
pub(crate) fn record_drop(driver: &AgentPubKey, order_ref: &ActionHash, release: &ActionHash) -> ExternResult<()> {
    record_reputation_event(driver, ReputationTargetWire::Driver(driver.clone()), order_ref.clone(), ReputationEventKindWire::DeliveryDropped, release.clone())
}

/// The driver `version` released, and whether they'd committed to it -- if
/// it's the version releasing one.
pub(crate) fn released_driver(version: &Record) -> ExternResult<Option<(AgentPubKey, bool)>> {
    let Some(version) = Version::of(version.clone()) else { return Ok(None) };
    let Some(prior) = version.prior()? else { return Ok(None) };
    if version.released(&prior).is_none() {
        return Ok(None);
    }
    Ok(driver_of(&prior.order)?.map(|(_, bid)| (bid.bidder, prior.order.collateral_hold.is_some())))
}

/// What a customer's app records when someone else changes their order: a
/// committed driver leaving it -- by their choice or the store's -- against
/// that driver (and off their queue), or the store handing over an order
/// they collected (the store's completed order). Best-effort, like every
/// reputation event.
pub(crate) fn record_what_changed(version: &Record, order_ref: &ActionHash, released: Option<&(AgentPubKey, bool)>) -> ExternResult<()> {
    let Some(order) = decode_or::<DeliveryOrder>(version) else { return Ok(()) };
    if order.requester != me()? {
        return Ok(());
    }
    let author = version.action().author();
    if let Some((driver, committed)) = released {
        unqueue_driver(order_ref, driver)?;
        // A driver the store kept waiting didn't drop it.
        let store_late = match Version::of(version.clone()) {
            Some(v) => v.prior()?.map(|p| lineage::is_store_late_release(&v, &p)).transpose()?.unwrap_or(false),
            None => false,
        };
        if *committed && !store_late {
            record_drop(driver, order_ref, version.action_address())?;
        } else if !committed {
            record_reputation_event(driver, ReputationTargetWire::Driver(driver.clone()), order_ref.clone(), ReputationEventKindWire::OfferLapsed, version.action_address().clone())?;
        }
    }
    if order.status == DeliveryStatus::Collected && author == &order.merchant {
        record_reputation_event(&order.merchant, ReputationTargetWire::Store(order.catalog_ref.clone()), order_ref.clone(), ReputationEventKindWire::OrderCompleted, version.action_address().clone())?;
    }
    Ok(())
}
