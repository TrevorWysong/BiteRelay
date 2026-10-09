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
//!
//! Each runs soon after what calls for it (the customer placing an order;
//! the store's `OrderPlaced` signal), and from a once-a-minute sweep
//! scheduled at `init`, which catches whatever a missed signal or a
//! restart left.

use crate::order_queues::{get_active_orders_for_store, get_my_active_orders, OrderEntry, OrderKind};
use crate::orders::{accept_delivery_order, cancel_delivery, open_scheduled_order};
use crate::pickup::{cancel_pickup, confirm_pickup_prep};
use crate::pricing::outdated_item;
use crate::stores::{current_catalog, my_stores};
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
    Some(Schedule::Persisted(SWEEP_CRON.into()))
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
    // A moment past the deadline, so the cancellation's own timestamp is
    // clearly beyond it.
    const SLACK: Duration = Duration::from_secs(1);
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
        let auto_accept = current_catalog(&store)?.auto_accept_orders;
        for entry in get_active_orders_for_store(store)? {
            let Some(waiting) = WaitingOrder::from_entry(&entry) else { continue };
            answers.waiting += 1;
            // Past the window the store can't accept it; the customer's
            // conductor cancels it.
            let expired = now >= entry.record.action().timestamp().as_micros() + window;
            if expired || !(auto_accept || waiting.bag_order) {
                continue;
            }
            if waiting.answer(&entry.original_action).is_err() {
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
    bag_order: bool,
}

impl WaitingOrder {
    fn from_entry(entry: &OrderEntry) -> Option<Self> {
        let (lines, bag_claim_ref) = match entry.kind {
            OrderKind::Delivery => {
                let order = decode_or::<DeliveryOrder>(&entry.record).filter(|o| o.status == DeliveryStatus::Placed)?;
                (order.lines, order.bag_claim_ref)
            }
            OrderKind::Pickup => {
                let order = decode_or::<PickupOrder>(&entry.record).filter(|o| o.status == PickupStatus::Placed)?;
                (order.lines, order.bag_claim_ref)
            }
        };
        Some(Self { kind: entry.kind.clone(), bag_order: bag_claim_ref.is_some(), lines, bag_claim_ref })
    }

    /// Accepts it, or declines it if it's priced from an outdated menu.
    fn answer(&self, order_ref: &ActionHash) -> ExternResult<()> {
        let outdated = outdated_item(order_ref, &self.lines, self.bag_claim_ref.as_ref())?.is_some();
        let decline = Cancellation::ByStore(DeclineReason::OutdatedPrices);
        match (&self.kind, outdated) {
            (OrderKind::Delivery, false) => accept_delivery_order(order_ref.clone()).map(|_| ()),
            (OrderKind::Delivery, true) => cancel_delivery(order_ref.clone(), decline).map(|_| ()),
            (OrderKind::Pickup, false) => confirm_pickup_prep(order_ref.clone()).map(|_| ()),
            (OrderKind::Pickup, true) => cancel_pickup(order_ref.clone(), decline).map(|_| ()),
        }
    }
}
