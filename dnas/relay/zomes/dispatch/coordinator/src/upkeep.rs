//! What an agent's own conductor does for them with no app open, on the
//! conductor's scheduler (as `settlement` does for store payouts):
//!
//! - **A customer's orders.** A confirmed goodie-bag claim becomes its
//!   order (`claims`), a recurring order fires when it's due, a
//!   scheduled order is placed with its store when it's due, and an order
//!   its store never answers is cancelled once the store's window passes
//!   (`Cancellation::StoreDidNotRespond`) -- so no customer waits on a
//!   store that's offline.
//! - **A store's new orders.** A store set to auto-accept accepts each one
//!   as it arrives, declining any priced from an outdated menu. A goodie-bag
//!   order, whose claim the store already confirmed, is accepted either way.
//! - **A customer's driver.** For an order set to match automatically, the
//!   best bid by the network's published rule is accepted once the bid
//!   window has run (`matching::auto_match`).
//! - **A store's deliveries.** Each committed driver is confirmed (the
//!   kitchen starts), one out of time is moved on, a customer's request to
//!   collect is recorded once it's allowed, and an order no driver came for
//!   is ended (`deliveries::tend_store_delivery`).
//! - **A driver's deliveries.** Each order whose customer accepted their
//!   bid is committed to, and each the store has handed over is picked up
//!   (`deliveries::tend_driver_deliveries`).
//!
//! Each runs soon after what calls for it (the customer placing an order;
//! the store's `OrderPlaced` signal), and from a once-a-minute sweep
//! scheduled at `init`, which catches whatever a missed signal or a
//! restart left.

use crate::order_queues::{get_active_orders_for_store, get_my_active_orders, OrderEntry, OrderKind};
use crate::orders::{accept_delivery_order, cancel_delivery, open_scheduled_order, AcceptOrderInput};
use crate::pickup::{accept_pickup_order, cancel_pickup};
use crate::pricing::outdated_item;
use crate::stores::{closed_reason, current_catalog, my_stores};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::decode_or;
use relay_governance::store_response_window;
use std::time::Duration;

/// Seconds, minutes, hours, day, month, weekday, year: every minute.
const SWEEP_CRON: &str = "0 * * * * * *";

/// Every minute, for as long as the conductor runs -- see the module doc.
/// Scheduled at `init`.
#[hdk_extern(infallible)]
pub fn tend_orders_periodically(_: Option<Schedule>) -> Option<Schedule> {
    let _ = tend_customer_orders();
    let _ = answer_store_orders();
    let _ = tend_store_deliveries();
    let _ = crate::deliveries::tend_driver_deliveries();
    Some(Schedule::Persisted(SWEEP_CRON.into()))
}

/// A moment past a deadline, so the update's own timestamp is clearly
/// beyond it.
const SLACK: Duration = Duration::from_secs(1);

// --- a store's deliveries ---

/// Asks the conductor to tend the caller's stores' deliveries now
/// (`tend_my_stores`). Called when one of them changes.
pub(crate) fn tend_my_stores_soon() -> ExternResult<()> {
    schedule("tend_my_stores")
}

/// Tends the caller's stores' deliveries, then runs again when the next one
/// falls due.
#[hdk_extern(infallible)]
pub fn tend_my_stores(_: Option<Schedule>) -> Option<Schedule> {
    match tend_store_deliveries() {
        Ok(Some(wait)) => Some(Schedule::Ephemeral(wait + SLACK)),
        _ => None,
    }
}

/// Tends every delivery at the caller's stores; returns how long until the
/// next one needs tending, if any does.
fn tend_store_deliveries() -> ExternResult<Option<Duration>> {
    let now = sys_time()?;
    let mut next: Option<Timestamp> = None;
    for store in my_stores()? {
        for entry in get_active_orders_for_store(store)? {
            let Some(order) = decode_or::<DeliveryOrder>(&entry.record).filter(|_| entry.kind == OrderKind::Delivery) else { continue };
            // One order failing (still gossiping, say) mustn't hold up the
            // rest; the next run tries it again.
            if let Ok(Some(due)) = crate::deliveries::tend_store_delivery(&entry.original_action, &entry.record, &order, now) {
                next = Some(next.map_or(due, |earliest| earliest.min(due)));
            }
        }
    }
    Ok(next.map(|due| Duration::from_micros(due.as_micros().saturating_sub(now.as_micros()).max(0) as u64)))
}

// --- a driver's deliveries ---

/// Asks the conductor to tend the caller's deliveries now
/// (`tend_my_deliveries`). Called when their bid is accepted, or the store
/// hands an order over.
pub(crate) fn tend_my_deliveries_soon() -> ExternResult<()> {
    schedule("tend_my_deliveries")
}

/// The signal can outrun what it's about, so this retries with backoff
/// until it's moved something on; the minute sweep covers anything later.
#[hdk_extern(infallible)]
pub fn tend_my_deliveries(previous: Option<Schedule>) -> Option<Schedule> {
    let moved = crate::deliveries::tend_driver_deliveries().is_ok_and(|n| n > 0);
    let next = match previous {
        Some(Schedule::Ephemeral(after)) => after * 2,
        _ => FIRST_RETRY,
    };
    (!moved && next <= LAST_RETRY).then_some(Schedule::Ephemeral(next))
}

// --- a customer's orders ---

/// Asks the conductor to tend the caller's orders now (`tend_my_orders`).
pub(crate) fn tend_my_orders_soon() -> ExternResult<()> {
    schedule("tend_my_orders")
}

/// The same, for another zome on this cell: the catalog's `ClaimConfirmed`
/// signal, so a confirmed claim becomes its order straight away.
#[hdk_extern]
pub fn schedule_order_upkeep(_: ()) -> ExternResult<()> {
    tend_my_orders_soon()
}

/// Places the caller's due scheduled orders with their stores and cancels
/// those their stores haven't answered in time, then runs again when the
/// next one falls due.
#[hdk_extern(infallible)]
pub fn tend_my_orders(_: Option<Schedule>) -> Option<Schedule> {
    match tend_customer_orders() {
        Ok(Some(wait)) => Some(Schedule::Ephemeral(wait + SLACK)),
        _ => None,
    }
}

/// When an order next needs tending, in microseconds since the epoch.
type DueAt = i64;

/// Tends every order of the caller's that's waiting on time; returns how
/// long until the next one needs tending, if any does.
fn tend_customer_orders() -> ExternResult<Option<Duration>> {
    let now = sys_time()?.as_micros();
    let window = store_response_window().as_micros() as i64;
    let mut next: Option<DueAt> = None;
    for entry in get_my_active_orders(())? {
        // One order failing (still gossiping, say) mustn't hold up the rest;
        // the next run tries it again.
        if let Ok(Some(due)) = tend_order(&entry, now, window) {
            next = Some(next.map_or(due, |earliest| earliest.min(due)));
        }
    }
    // Confirmed goodie-bag claims become their orders.
    crate::claims::redeem_confirmed_claims()?;
    // Standing orders that are due fire too.
    if let Some(due) = crate::recurring::tend_templates(now)? {
        next = Some(next.map_or(due, |earliest| earliest.min(due)));
    }
    Ok(next.map(|due| Duration::from_micros(due.saturating_sub(now).max(0) as u64)))
}

/// Tends one order; returns when it next needs tending, if it will.
fn tend_order(entry: &OrderEntry, now: DueAt, window: i64) -> ExternResult<Option<DueAt>> {
    // The latest version's timestamp: for an order waiting on its store,
    // when it reached the store -- what validation measures the window from.
    let written_at = entry.record.action().timestamp().as_micros();
    let order_ref = entry.original_action.clone();
    match entry.kind {
        OrderKind::Delivery => {
            let Some(order) = decode_or::<DeliveryOrder>(&entry.record) else { return Ok(None) };
            match order.status {
                DeliveryStatus::Scheduled => {
                    let due = order.requested_delivery_time.map_or(now, |at| at.as_micros());
                    if now < due {
                        return Ok(Some(due));
                    }
                    open_scheduled_order(order_ref)?;
                    Ok(Some(now + window))
                }
                DeliveryStatus::Placed if now >= written_at + window => {
                    cancel_delivery(order_ref, Cancellation::StoreDidNotRespond)?;
                    Ok(None)
                }
                DeliveryStatus::Placed => Ok(Some(written_at + window)),
                DeliveryStatus::Open if order.auto_match => Ok(crate::matching::auto_match(&order_ref, &order, now)?.map(|due| due.as_micros())),
                // The driver committed: they get the address, in a call of its
                // own (`deliveries::share_address`).
                _ if crate::deliveries::owed_driver(&order_ref, &order)?.is_some() => {
                    let zome = zome_info()?.name;
                    call(CallTargetCell::Local, zome, "share_address".into(), None, order_ref)?;
                    Ok(None)
                }
                _ => Ok(None),
            }
        }
        OrderKind::Pickup => {
            let Some(order) = decode_or::<PickupOrder>(&entry.record) else { return Ok(None) };
            match order.status {
                PickupStatus::Placed if now >= written_at + window => {
                    cancel_pickup(order_ref, Cancellation::StoreDidNotRespond)?;
                    Ok(None)
                }
                PickupStatus::Placed => Ok(Some(written_at + window)),
                _ => Ok(None),
            }
        }
    }
}

// --- a store's new orders ---

/// Asks the conductor to answer the caller's stores' new orders now
/// (`answer_new_orders`). Called on the `OrderPlaced` signal.
pub(crate) fn answer_new_orders_soon() -> ExternResult<()> {
    schedule("answer_new_orders")
}

const FIRST_RETRY: Duration = Duration::from_secs(5);
const LAST_RETRY: Duration = Duration::from_secs(40);

/// The signal can arrive before the order has reached the store's queue,
/// so this retries with backoff (5s, 10s, ... ~75s in all) until it has
/// seen a waiting order and answered every one it should; the minute sweep
/// covers anything later.
#[hdk_extern(infallible)]
pub fn answer_new_orders(previous: Option<Schedule>) -> Option<Schedule> {
    let settled = matches!(answer_store_orders(), Ok(Answers { waiting, failed: 0 }) if waiting > 0);
    let next = match previous {
        Some(Schedule::Ephemeral(after)) => after * 2,
        _ => FIRST_RETRY,
    };
    (!settled && next <= LAST_RETRY).then_some(Schedule::Ephemeral(next))
}

struct Answers {
    /// Orders waiting on one of the caller's stores.
    waiting: u32,
    /// Orders it should have answered but couldn't yet.
    failed: u32,
}

/// Answers every waiting order the caller's stores answer automatically.
fn answer_store_orders() -> ExternResult<Answers> {
    let now = sys_time()?.as_micros();
    let window = store_response_window().as_micros() as i64;
    let mut answers = Answers { waiting: 0, failed: 0 };
    for store in my_stores()? {
        let catalog = current_catalog(&store)?;
        // Taking orders right now? An order placed while closed slipped past
        // the customer's own check, and is declined as such.
        let open_now = closed_reason(&catalog, now).is_none();
        for entry in get_active_orders_for_store(store)? {
            let Some(waiting) = WaitingOrder::from_entry(&entry) else { continue };
            answers.waiting += 1;
            // Past the window the store can't accept it; the customer's
            // conductor cancels it.
            let expired = now >= entry.record.action().timestamp().as_micros() + window;
            if expired || !(catalog.auto_accept_orders || waiting.bag_order) {
                continue;
            }
            if waiting.answer(&entry.original_action, open_now).is_err() {
                answers.failed += 1;
            }
        }
    }
    Ok(answers)
}

/// An order waiting on its store to accept it.
struct WaitingOrder {
    kind: OrderKind,
    lines: Vec<OrderLine>,
    bag_claim_ref: Option<ActionHash>,
    promo_code_ref: Option<ActionHash>,
    bag_order: bool,
    catalog_ref: ActionHash,
    /// The store terms it was placed under.
    catalog_version: ActionHash,
}

impl WaitingOrder {
    fn from_entry(entry: &OrderEntry) -> Option<Self> {
        let (lines, bag_claim_ref, promo_code_ref, catalog_ref, catalog_version) = match entry.kind {
            OrderKind::Delivery => {
                let order = decode_or::<DeliveryOrder>(&entry.record).filter(|o| o.status == DeliveryStatus::Placed)?;
                (order.lines, order.bag_claim_ref, order.promo_code_ref, order.catalog_ref, order.catalog_version)
            }
            OrderKind::Pickup => {
                let order = decode_or::<PickupOrder>(&entry.record).filter(|o| o.status == PickupStatus::Placed)?;
                (order.lines, order.bag_claim_ref, order.promo_code_ref, order.catalog_ref, order.catalog_version)
            }
        };
        Some(Self { kind: entry.kind, bag_order: bag_claim_ref.is_some(), lines, bag_claim_ref, promo_code_ref, catalog_ref, catalog_version })
    }

    /// Accepts it, with the store's usual prep time -- or declines it if
    /// the store is closed (a goodie bag runs on its own window), it
    /// redeems a goodie bag whose hold lapsed, it was placed under the
    /// store's earlier terms, or it's priced from an outdated menu.
    fn answer(&self, order_ref: &ActionHash, open_now: bool) -> ExternResult<()> {
        let decline = if !open_now && !self.bag_order {
            Some(DeclineReason::Closed)
        } else if self.bag_claim_ref.as_ref().map(crate::claims::bag_hold_lapsed).transpose()?.unwrap_or(false) {
            Some(DeclineReason::BagHoldLapsed)
        } else if crate::pricing::terms_outdated(order_ref, &self.catalog_ref, &self.catalog_version)? {
            Some(DeclineReason::TermsChanged)
        } else if outdated_item(order_ref, &self.lines, self.bag_claim_ref.as_ref(), self.promo_code_ref.as_ref())?.is_some() {
            Some(DeclineReason::OutdatedPrices)
        } else {
            None
        };
        let accept = AcceptOrderInput { order_original_action: order_ref.clone(), prep_minutes: None };
        match (&self.kind, decline) {
            (OrderKind::Delivery, None) => accept_delivery_order(accept).map(|_| ()),
            (OrderKind::Delivery, Some(reason)) => cancel_delivery(order_ref.clone(), Cancellation::ByStore(reason)).map(|_| ()),
            (OrderKind::Pickup, None) => accept_pickup_order(accept).map(|_| ()),
            (OrderKind::Pickup, Some(reason)) => cancel_pickup(order_ref.clone(), Cancellation::ByStore(reason)).map(|_| ()),
        }
    }
}
