//! Paying for completed orders. What an order owes is defined once
//! (`dispatch_types::settlement`), and the ledger accepts each leg only
//! from its own payer -- so whoever completes an order pays the legs *they*
//! owe, and the store pays its share of the delivery fee from its own
//! conductor: the customer's completion signals it, which schedules a
//! settle run (`settle_store_shares_soon`), and a periodic sweep catches
//! anything a missed signal left. Neither needs the store's app open. An
//! arbitrator carrying out a ruling settles every leg.

use crate::order_queues::QueueOwnerExt;
use dispatch_integrity::*;
use crate::stores::my_stores;
use hdk::prelude::*;
use relay_coordinator_support::resolve_latest_fresh;

#[derive(Serialize, Debug)]
struct PayInputWire {
    leg: PaymentLeg,
    related_order: ActionHash,
    basis: ActionHash,
    from: AgentPubKey,
    to: AgentPubKey,
    amount: u64,
}

#[derive(Serialize, Debug)]
struct ForfeitInputWire {
    related_order: ActionHash,
    dispute: ActionHash,
    from: AgentPubKey,
    to: AgentPubKey,
    amount: u64,
}

/// Who's paying: the caller, for the legs they owe -- or an arbitrator
/// settling a ruling, for every leg.
pub(crate) enum Payer<'a> {
    Me(&'a AgentPubKey),
    Arbitrator,
}

/// Pays `legs` that `payer` owes for the order completed by `basis`. Each
/// leg is idempotent in the ledger, so this is safe to retry.
pub(crate) fn pay_legs(order_ref: &ActionHash, basis: &ActionHash, legs: &[LegPayment], payer: Payer<'_>) -> ExternResult<()> {
    for payment in legs {
        if let Payer::Me(me) = payer {
            if &payment.from != me {
                continue;
            }
        }
        let input = PayInputWire {
            leg: payment.leg,
            related_order: order_ref.clone(),
            basis: basis.clone(),
            from: payment.from.clone(),
            to: payment.to.clone(),
            amount: payment.amount,
        };
        let ZomeCallResponse::Ok(_) = call(CallTargetCell::Local, "ledger", "pay".into(), None, input)? else {
            return Err(wasm_error!(WasmErrorInner::Guest(format!("paying {:?} failed", payment.leg))));
        };
    }
    Ok(())
}

/// Moves collateral per an arbitrator's ruling (`dispute` is the resolved
/// `Dispute` record). Nothing to do for a zero amount.
pub(crate) fn forfeit(order_ref: &ActionHash, dispute: &ActionHash, from: &AgentPubKey, to: &AgentPubKey, amount: u64) -> ExternResult<()> {
    if amount == 0 {
        return Ok(());
    }
    let input = ForfeitInputWire { related_order: order_ref.clone(), dispute: dispute.clone(), from: from.clone(), to: to.clone(), amount };
    let ZomeCallResponse::Ok(_) = call(CallTargetCell::Local, "ledger", "forfeit".into(), None, input)? else {
        return Err(wasm_error!(WasmErrorInner::Guest("collateral forfeiture failed".into())));
    };
    Ok(())
}

/// What the caller's store owes on a delivered order, read fresh from the
/// network, with the version that completed it -- `None` if there's
/// nothing for the caller to pay.
fn store_share_due(order_ref: &ActionHash) -> ExternResult<Option<(ActionHash, Vec<LegPayment>)>> {
    let me = agent_info()?.agent_initial_pubkey;
    let record = resolve_latest_fresh(order_ref.clone())?;
    let Some(order) = record.entry().to_app_option::<DeliveryOrder>().ok().flatten() else { return Ok(None) };
    if order.status != DeliveryStatus::Delivered || order.merchant != me {
        return Ok(None);
    }
    let Some(bid_ref) = &order.accepted_bid else { return Ok(None) };
    let Some(bid) = resolve_latest_fresh(bid_ref.clone())?.entry().to_app_option::<Bid>().ok().flatten() else { return Ok(None) };
    let legs: Vec<LegPayment> = delivery_payments(&order, &bid).into_iter().filter(|p| p.leg == PaymentLeg::DeliveryFeeStoreShare && p.from == me).collect();
    Ok((!legs.is_empty()).then(|| (record.action_address().clone(), legs)))
}

/// Pays the caller's store share of the delivery fee for one delivered
/// order. Safe to call any number of times.
#[hdk_extern]
pub fn pay_store_share(order_original_action: ActionHash) -> ExternResult<()> {
    let Some((basis, legs)) = store_share_due(&order_original_action)? else { return Ok(()) };
    let me = agent_info()?.agent_initial_pubkey;
    pay_legs(&order_original_action, &basis, &legs, Payer::Me(&me))
}

/// How far back the sweep looks for delivered orders.
const SWEEP_DAYS: i64 = 2;

struct Sweep {
    paid: u32,
    /// Shares that couldn't be paid yet (the order or its completion still
    /// gossiping) -- worth another try.
    pending: u32,
}

/// Pays every store share the caller's stores still owe on orders from the
/// last couple of days.
fn sweep() -> ExternResult<Sweep> {
    let stores = my_stores()?;
    if stores.is_empty() {
        return Ok(Sweep { paid: 0, pending: 0 });
    }
    let me = agent_info()?.agent_initial_pubkey;
    let paid_already = already_paid_store_shares()?;
    let today = history_day(sys_time()?);
    let mut result = Sweep { paid: 0, pending: 0 };
    for store in stores {
        let owner = QueueOwner::Store(&store);
        for day in (today - SWEEP_DAYS + 1)..=today {
            for order_ref in owner.orders_on_day(day)? {
                if paid_already.contains(&order_ref) {
                    continue;
                }
                let outcome = store_share_due(&order_ref).and_then(|due| match due {
                    Some((basis, legs)) => pay_legs(&order_ref, &basis, &legs, Payer::Me(&me)).map(|_| true),
                    None => Ok(false),
                });
                match outcome {
                    Ok(true) => result.paid += 1,
                    Ok(false) => {}
                    Err(_) => result.pending += 1,
                }
            }
        }
    }
    Ok(result)
}

/// Pays every store share the caller's stores still owe on recent orders;
/// returns how many it paid. The conductor runs this on its own (below);
/// callable directly too, and always safe.
#[hdk_extern]
pub fn pay_outstanding_store_shares(_: ()) -> ExternResult<u32> {
    Ok(sweep()?.paid)
}

const FIRST_RETRY: core::time::Duration = core::time::Duration::from_secs(10);
const LAST_RETRY: core::time::Duration = core::time::Duration::from_secs(160);

/// Scheduled when a delivery signals the store's share is due. The signal
/// can arrive before the completed order has reached the store, so this
/// retries with backoff (10s, 20s, ... ~5 minutes in all) until it has
/// paid something and nothing's left pending; the periodic sweep covers
/// anything later.
#[hdk_extern(infallible)]
pub fn settle_store_shares_soon(previous: Option<Schedule>) -> Option<Schedule> {
    let settled = matches!(sweep(), Ok(Sweep { paid, pending: 0 }) if paid > 0);
    let next = match previous {
        Some(Schedule::Ephemeral(after)) => after * 2,
        _ => FIRST_RETRY,
    };
    (!settled && next <= LAST_RETRY).then_some(Schedule::Ephemeral(next))
}

/// Every five minutes, for as long as the conductor runs: a store that was
/// offline (or missed a signal) pays what it owes without anyone needing to
/// have the app open. Scheduled at `init`.
#[hdk_extern(infallible)]
pub fn settle_store_shares_periodically(_: Option<Schedule>) -> Option<Schedule> {
    let _ = sweep();
    Some(Schedule::Persisted(SWEEP_CRON.into()))
}

/// Seconds, minutes, hours, day, month, weekday, year.
const SWEEP_CRON: &str = "0 */5 * * * * *";

/// Orders the caller has already paid a store share on -- from their own
/// chain, since they authored every such payment.
fn already_paid_store_shares() -> ExternResult<Vec<ActionHash>> {
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "ledger", "my_paid_orders".into(), None, PaymentLeg::DeliveryFeeStoreShare)? else {
        return Err(wasm_error!(WasmErrorInner::Guest("reading your payments failed".into())));
    };
    io.decode().map_err(|e| wasm_error!(e))
}
