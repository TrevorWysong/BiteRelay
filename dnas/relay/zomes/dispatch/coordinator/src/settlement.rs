//! Holding and settling the money for orders. The model is
//! `dispatch_types::settlement`; the rules are `ledger_integrity`'s.
//!
//! Each step of an order sets aside what its author owes for it
//! (`place_hold`), in the same call as the step, so the two commit together
//! and validation won't accept the step without it. Settling is then each
//! party's own business, done from their own conductor: for every part of
//! an order's holds that's theirs to decide, collect it on the decision that
//! entitles them (the store's outcome or settlement, a cancellation), or
//! waive it back to its payer; and as a payer, collect what's come back.
//! The store's conductor makes its decisions first (`issues`). Nobody pays
//! anybody else's way -- so nobody can skip paying.

use dispatch_integrity::*;
use crate::stores::my_stores;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, original_action_of};

fn guest(message: impl Into<String>) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message.into()))
}

fn ledger<I: Serialize + std::fmt::Debug, O: serde::de::DeserializeOwned + std::fmt::Debug>(function: &str, input: I) -> ExternResult<O> {
    match call(CallTargetCell::Local, "ledger", function.into(), None, input)? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e)),
        other => Err(guest(format!("{function}: {other:?}"))),
    }
}

#[derive(Serialize, Debug)]
struct PlaceHoldWire {
    order: ActionHash,
    purpose: HoldPurpose,
}

/// Sets aside what the caller owes for `purpose` on an order -- `None` if
/// nothing's owed. Fails if the caller can't cover it.
pub(crate) fn place_hold(order: &ActionHash, purpose: HoldPurpose) -> ExternResult<Option<ActionHash>> {
    ledger("place_hold", PlaceHoldWire { order: order.clone(), purpose })
}

/// Mirrors `ledger::ShareView`/`HoldView` over the zome-call boundary.
#[derive(Deserialize, Debug, Clone)]
pub(crate) struct ShareWire {
    pub portion: Portion,
    pub recipient: AgentPubKey,
    pub amount: u64,
}

#[derive(Deserialize, Debug, Clone)]
pub(crate) struct HoldWire {
    pub hold: ActionHash,
    pub payer: AgentPubKey,
    pub purpose: HoldPurpose,
    pub shares: Vec<ShareWire>,
}

pub(crate) fn holds_for_order(order: &ActionHash) -> ExternResult<Vec<HoldWire>> {
    ledger("holds_for_order", order.clone())
}

/// The order's hold for `purpose`, paid by `payer`, if it's been placed.
pub(crate) fn find_hold(order: &ActionHash, purpose: &HoldPurpose, payer: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
    Ok(holds_for_order(order)?.into_iter().find(|h| &h.purpose == purpose && &h.payer == payer).map(|h| h.hold))
}

/// Whether anything is owed for `purpose` on an order (its original action):
/// nothing is, for a customer ordering from their own store, or a fee the
/// store covers in full.
pub(crate) fn owes(order: &ActionHash, purpose: &HoldPurpose, bid: Option<&Bid>) -> ExternResult<bool> {
    let record = get(order.clone(), GetOptions::default())?.ok_or(guest("order not found"))?;
    let terms = match (decode_or::<DeliveryOrder>(&record), decode_or::<PickupOrder>(&record)) {
        (Some(order), _) => OrderTerms::of_delivery(&order),
        (None, Some(order)) => OrderTerms::of_pickup(&order),
        _ => return Err(guest("that isn't an order")),
    };
    Ok(hold_terms(&terms, purpose, bid).is_some_and(|(_, shares)| !shares.is_empty()))
}

/// The hold a step needs: an existing one, if the payer already set it
/// aside, or `None` if nothing's owed -- an error if something's owed and
/// hasn't been held.
pub(crate) fn required_hold(order: &ActionHash, purpose: HoldPurpose, payer: &AgentPubKey, owed: bool) -> ExternResult<Option<ActionHash>> {
    if !owed {
        return Ok(None);
    }
    find_hold(order, &purpose, payer)?.map(Some).ok_or(guest("this order's payment hasn't been set aside yet -- try again in a moment"))
}

// --- what's known about an order, for settling it ---

/// How far an order had got when it was cancelled -- mirrors
/// `ledger_integrity::Stage`.
#[derive(PartialEq, Eq)]
enum Stage {
    Waiting,
    Accepted,
    DriverAssigned,
    Other,
}

struct Facts {
    /// The store's decisions (see `issues`).
    decisions: crate::issues::Decisions,
    /// The order's cancellation, and how far it had got.
    cancellation: Option<(ActionHash, Cancellation, Stage)>,
}

/// Every version of an order, original first then each update, across any
/// branches.
fn versions(order: &ActionHash) -> ExternResult<Vec<Record>> {
    let mut out = Vec::new();
    let mut frontier = vec![order.clone()];
    while let Some(hash) = frontier.pop() {
        let Some(Details::Record(details)) = get_details(hash, GetOptions::default())? else { continue };
        frontier.extend(details.updates.iter().map(|u| u.action_address().clone()));
        out.push(details.record);
    }
    Ok(out)
}

fn facts(order: &ActionHash) -> ExternResult<Option<Facts>> {
    let all = versions(order)?;
    let Some(original) = all.first() else { return Ok(None) };
    let delivery = decode_or::<DeliveryOrder>(original).is_some();
    let mut facts = Facts { decisions: crate::issues::decisions_of(order)?, cancellation: None };
    for version in &all {
        let prior = match &version.action().data {
            ActionData::Update(update) => all.iter().find(|r| r.action_address() == &update.original_action_address),
            _ => None,
        };
        let (cancellation, stage) = if delivery {
            let Some(o) = decode_or::<DeliveryOrder>(version) else { continue };
            let stage = prior.and_then(decode_or::<DeliveryOrder>).map(|p| match p.status {
                DeliveryStatus::Scheduled | DeliveryStatus::Placed => Stage::Waiting,
                DeliveryStatus::Open => Stage::Accepted,
                DeliveryStatus::BidAccepted | DeliveryStatus::MerchantConfirmed | DeliveryStatus::DriverEnRouteToMerchant => Stage::DriverAssigned,
                _ => Stage::Other,
            });
            (o.cancellation, stage)
        } else {
            let Some(o) = decode_or::<PickupOrder>(version) else { continue };
            let stage = prior.and_then(decode_or::<PickupOrder>).map(|p| match p.status {
                PickupStatus::Placed => Stage::Waiting,
                PickupStatus::MerchantConfirmed | PickupStatus::ReadyForPickup => Stage::Accepted,
                _ => Stage::Other,
            });
            (o.cancellation, stage)
        };
        if let (Some(cancellation), Some(stage)) = (cancellation, stage) {
            facts.cancellation = Some((version.action_address().clone(), cancellation, stage));
        }
    }
    Ok(Some(facts))
}

// --- deciding ---

#[derive(Serialize, Debug)]
struct DecideWire {
    hold: ActionHash,
    portion: Portion,
}

#[derive(Serialize, Debug)]
struct CollectWire {
    hold: ActionHash,
    portion: Portion,
    basis: ActionHash,
}

/// Mirrors `ledger::WaiverView`.
#[derive(Deserialize, Debug)]
struct WaiverWire {
    waiver: ActionHash,
    portion: Portion,
    by: AgentPubKey,
}

/// What the caller should do with one part of one hold.
enum Decision {
    Collect(ActionHash),
    Waive,
}

/// The rules in `ledger_integrity::validate_collect`, from the caller's
/// side: what they're owed, and on what.
fn decide(me: &AgentPubKey, hold: &HoldWire, share: &ShareWire, facts: &Facts) -> ExternResult<Option<Decision>> {
    let recipient = &share.recipient == me;
    let payer = &hold.payer == me;
    let d = &facts.decisions;
    // Once the store has decided, its decision settles the part.
    let decided = match share.portion {
        Portion::Food => match (&d.settlement, &d.not_delivered) {
            (Some((settlement, refund)), _) => {
                let mine = if recipient { share.amount.saturating_sub(*refund) } else if payer { *refund } else { 0 };
                Some((mine > 0).then(|| Decision::Collect(settlement.clone())))
            }
            (None, Some(outcome)) => Some(payer.then(|| Decision::Collect(outcome.clone()))),
            (None, None) => None,
        },
        Portion::Collateral => match (&d.delivered, &d.not_delivered) {
            (Some(outcome), _) => Some(payer.then(|| Decision::Collect(outcome.clone()))),
            (None, Some(outcome)) => Some(recipient.then(|| Decision::Collect(outcome.clone()))),
            _ => None,
        },
        Portion::Fee | Portion::Tip => match (&d.delivered, &d.not_delivered) {
            (Some(outcome), _) => Some(recipient.then(|| Decision::Collect(outcome.clone()))),
            (None, Some(outcome)) => Some(payer.then(|| Decision::Collect(outcome.clone()))),
            _ => None,
        },
    };
    if let Some(decision) = decided {
        return Ok(decision);
    }
    if recipient {
        if let Some((version, by, stage)) = &facts.cancellation {
            let owed = *by == Cancellation::ByCustomer
                && match share.portion {
                    Portion::Food => matches!(stage, Stage::Accepted | Stage::DriverAssigned),
                    Portion::Fee => *stage == Stage::DriverAssigned && matches!(hold.purpose, HoldPurpose::DriverPay { .. }),
                    _ => false,
                };
            return Ok(Some(if owed { Decision::Collect(version.clone()) } else { Decision::Waive }));
        }
        return Ok(None);
    }
    if payer {
        let waivers: Vec<WaiverWire> = ledger("waivers_for_hold", hold.hold.clone())?;
        if let Some(waiver) = waivers.into_iter().find(|w| w.portion == share.portion && w.by == share.recipient) {
            return Ok(Some(Decision::Collect(waiver.waiver)));
        }
    }
    Ok(None)
}

/// Settles what the caller can on one order; returns how many parts it
/// decided. Each part is decided once (the ledger refuses a second), so this
/// is safe to call any number of times.
pub(crate) fn settle(order: &ActionHash) -> ExternResult<u32> {
    let order = original_action_of(order.clone())?;
    let holds = holds_for_order(&order)?;
    let me = agent_info()?.agent_initial_pubkey;
    let mine = |h: &HoldWire| h.payer == me || h.shares.iter().any(|s| s.recipient == me);
    if !holds.iter().any(mine) {
        return Ok(0);
    }
    // The store makes its decisions first -- in a call of its own, so one
    // that doesn't validate yet can't undo the rest.
    crate::issues::decide_as_store(&order);
    let Some(facts) = facts(&order)? else { return Ok(0) };
    let mut decided = 0;
    // Payers whose money this gave back, to tell them it's theirs to collect.
    let mut returned: Vec<AgentPubKey> = Vec::new();
    for hold in holds.iter().filter(|h| mine(h)) {
        for share in &hold.shares {
            let already: bool = ledger("have_i_decided", DecideWire { hold: hold.hold.clone(), portion: share.portion })?;
            if already {
                continue;
            }
            let outcome = match decide(&me, hold, share, &facts)? {
                Some(Decision::Collect(basis)) => ledger::<_, ActionHash>("collect", CollectWire { hold: hold.hold.clone(), portion: share.portion, basis }).map(|_| ()),
                Some(Decision::Waive) => ledger::<_, ActionHash>("waive", DecideWire { hold: hold.hold.clone(), portion: share.portion }).map(|_| {
                    if !returned.contains(&hold.payer) {
                        returned.push(hold.payer.clone());
                    }
                }),
                None => continue,
            };
            if outcome.is_ok() {
                decided += 1;
            }
        }
    }
    if !returned.is_empty() {
        let _ = send_remote_signal(crate::signals::RemoteSignal::Returned { order_hash: order.clone() }, returned);
    }
    Ok(decided)
}

/// Settles what the caller can on one order -- for a screen that's just
/// seen it change.
#[hdk_extern]
pub fn settle_order(order_original_action: ActionHash) -> ExternResult<u32> {
    settle(&order_original_action)
}

// --- the sweep ---

/// Orders the caller might have money to settle on, from the last `days`:
/// those they placed, bid on, or received at one of their stores.
fn candidates(days: i64) -> ExternResult<Vec<ActionHash>> {
    let since = sys_time()?.as_micros() - days * 86_400_000_000;
    let mut orders: Vec<ActionHash> = Vec::new();
    for unit in [UnitEntryTypes::DeliveryOrder, UnitEntryTypes::PickupOrder, UnitEntryTypes::Bid] {
        let filter = ChainQueryFilter::new().entry_type(EntryType::try_from(unit)?).include_entries(true);
        for record in query(filter)? {
            if record.action().timestamp().as_micros() < since {
                continue;
            }
            let order = match decode_or::<Bid>(&record) {
                Some(bid) => original_action_of(bid.order_ref).ok(),
                None if matches!(record.action().data, ActionData::Create(_)) => Some(record.action_address().clone()),
                None => None,
            };
            orders.extend(order);
        }
    }
    let today = history_day(sys_time()?);
    for store in my_stores()? {
        let owner = QueueOwner::Store(&store);
        for day in (today - days)..=today {
            orders.extend(owner.orders_on_day(day)?);
        }
    }
    orders.sort();
    orders.dedup();
    Ok(orders)
}

/// Settles every recent order the caller has a part in; returns how many
/// parts it decided.
/// Settles each candidate in a zome call of its own: a write that doesn't
/// validate yet (its basis still gossiping here) fails only that order's
/// call, never the rest of the sweep.
fn sweep(days: i64) -> u32 {
    let Ok(zome) = zome_info().map(|z| z.name) else { return 0 };
    candidates(days)
        .unwrap_or_default()
        .into_iter()
        .map(|order| match call(CallTargetCell::Local, zome.clone(), "settle_order".into(), None, order) {
            Ok(ZomeCallResponse::Ok(io)) => io.decode::<u32>().unwrap_or(0),
            _ => 0,
        })
        .sum()
}

use crate::order_queues::QueueOwnerExt;

/// The window a regular sweep covers. A store's decision can come later
/// than this; its signal triggers a longer sweep (`settle_soon`).
const SWEEP_DAYS: i64 = 2;
const SIGNALLED_SWEEP_DAYS: i64 = 30;

/// Every five minutes, for as long as the conductor runs: what's owed is
/// collected without anyone having the app open. Scheduled at `init`.
#[hdk_extern(infallible)]
pub fn settle_periodically(_: Option<Schedule>) -> Option<Schedule> {
    let _ = sweep(SWEEP_DAYS);
    Some(Schedule::Persisted(SWEEP_CRON.into()))
}

/// Seconds, minutes, hours, day, month, weekday, year.
const SWEEP_CRON: &str = "0 */5 * * * * *";

const FIRST_RETRY: core::time::Duration = core::time::Duration::from_secs(5);
const LAST_RETRY: core::time::Duration = core::time::Duration::from_secs(160);

/// Scheduled when one of the caller's orders changes (its signal). The
/// change may not have reached the caller yet, so this retries with backoff
/// -- and progress restarts the backoff, as signals that arrive meanwhile
/// share this one schedule: a burst of orders is followed until it's quiet.
/// The regular sweep covers anything later.
#[hdk_extern(infallible)]
pub fn settle_soon(previous: Option<Schedule>) -> Option<Schedule> {
    let settled = sweep(SIGNALLED_SWEEP_DAYS) > 0;
    let next = match previous {
        Some(Schedule::Ephemeral(after)) if !settled => after * 2,
        _ => FIRST_RETRY,
    };
    (next <= LAST_RETRY).then_some(Schedule::Ephemeral(next))
}
