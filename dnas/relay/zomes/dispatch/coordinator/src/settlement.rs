//! Holding and settling the money for orders. The model is
//! `dispatch_types::settlement`; the rules are `ledger_integrity`'s.
//!
//! Each step of an order sets aside what its author owes for it
//! (`place_hold`), in the same call as the step, so the two commit together
//! and validation won't accept the step without it. Settling is then each
//! party's own business, done from their own conductor: for every part of
//! an order's holds that's theirs to decide, collect it with the proof
//! that entitles them (the customer's receipt, a ruling, a cancellation),
//! or waive it back to its payer; and as a payer, collect what's come back.
//! Nobody pays anybody else's way -- so nobody can skip paying.

use attestation_types::{Leg, LegKind};
use dispatch_integrity::*;
use crate::stores::my_stores;
use dispute_types::{Dispute, DisputeOutcome, DisputeStatus};
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
    /// The customer's receipt: for a delivery, their acknowledgment of the
    /// drop-off; for a pickup, their update collecting it.
    receipt: Option<ActionHash>,
    /// An arbitrator's ruling applied to the order, and whether it left the
    /// order cancelled by its customer.
    ruling: Option<(ActionHash, DisputeOutcome, Option<Cancellation>)>,
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
    let delivery = decode_or::<DeliveryOrder>(original);
    let requester = match (&delivery, decode_or::<PickupOrder>(original)) {
        (Some(o), _) => o.requester.clone(),
        (None, Some(o)) => o.requester.clone(),
        _ => return Ok(None),
    };
    let mut facts = Facts { receipt: None, ruling: None, cancellation: None };
    for version in &all {
        let author = version.action().author();
        let prior = match &version.action().data {
            ActionData::Update(update) => all.iter().find(|r| r.action_address() == &update.original_action_address),
            _ => None,
        };
        let (cancellation, dispute_ref, picked_up, stage) = if delivery.is_some() {
            let Some(o) = decode_or::<DeliveryOrder>(version) else { continue };
            let stage = prior.and_then(decode_or::<DeliveryOrder>).map(|p| match p.status {
                DeliveryStatus::Scheduled | DeliveryStatus::Placed => Stage::Waiting,
                DeliveryStatus::Open => Stage::Accepted,
                DeliveryStatus::BidAccepted | DeliveryStatus::MerchantConfirmed | DeliveryStatus::DriverEnRouteToMerchant => Stage::DriverAssigned,
                _ => Stage::Other,
            });
            (o.cancellation, o.dispute_ref, false, stage)
        } else {
            let Some(o) = decode_or::<PickupOrder>(version) else { continue };
            let stage = prior.and_then(decode_or::<PickupOrder>).map(|p| match p.status {
                PickupStatus::Placed => Stage::Waiting,
                PickupStatus::MerchantConfirmed | PickupStatus::ReadyForPickup => Stage::Accepted,
                _ => Stage::Other,
            });
            (o.cancellation, o.dispute_ref, o.status == PickupStatus::PickedUp, stage)
        };
        if relay_governance::is_arbitrator(author)? {
            if let Some(dispute_ref) = dispute_ref {
                if let Some(dispute) = get(dispute_ref, GetOptions::default())?.and_then(|r| decode_or::<Dispute>(&r)) {
                    if let (DisputeStatus::Resolved, Some(outcome)) = (dispute.status, dispute.outcome) {
                        facts.ruling = Some((version.action_address().clone(), outcome, cancellation));
                    }
                }
            }
            continue;
        }
        if picked_up && author == &requester {
            facts.receipt = Some(version.action_address().clone());
        }
        // The update that cancelled the order -- not a later one that only
        // carries its cancellation forward (raising a cancellation dispute
        // does), which would read as cancelled from "already cancelled".
        if let (Some(cancellation), Some(stage)) = (cancellation, stage) {
            if stage != Stage::Other {
                facts.cancellation = Some((version.action_address().clone(), cancellation, stage));
            }
        }
    }
    if delivery.is_some() {
        facts.receipt = delivery_receipt(order, &requester)?;
    }
    Ok(Some(facts))
}

/// The customer's acknowledgment of a delivery's drop-off, if they've given it.
fn delivery_receipt(order: &ActionHash, requester: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "attestation", "get_legs_for_order".into(), None, order.clone())? else { return Ok(None) };
    let legs: Vec<Record> = io.decode().map_err(|e| wasm_error!(e))?;
    for leg in legs {
        let Some(l) = decode_or::<Leg>(&leg) else { continue };
        if l.kind != LegKind::CustomerHandoff {
            continue;
        }
        let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "attestation", "get_receipt_for_leg".into(), None, leg.action_address().clone())? else { continue };
        let receipt: Option<Record> = io.decode().map_err(|e| wasm_error!(e))?;
        if let Some(receipt) = receipt.filter(|r| r.action().author() == requester) {
            return Ok(Some(receipt.action_address().clone()));
        }
    }
    Ok(None)
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

fn decide(me: &AgentPubKey, hold: &HoldWire, share: &ShareWire, facts: &Facts) -> ExternResult<Option<Decision>> {
    let favor = |side: &DisputeOutcome| facts.ruling.as_ref().filter(|(_, outcome, _)| outcome == side).map(|(version, _, c)| (version.clone(), c.clone()));
    let receipt_or_ruling = facts.receipt.clone().or_else(|| favor(&DisputeOutcome::FavorProvider).map(|(v, _)| v));
    if share.portion == Portion::Collateral {
        return Ok(if &hold.payer == me {
            receipt_or_ruling.map(Decision::Collect)
        } else if &share.recipient == me {
            favor(&DisputeOutcome::FavorRequester).map(|(v, _)| Decision::Collect(v))
        } else {
            None
        });
    }
    if &share.recipient == me {
        if let Some(basis) = receipt_or_ruling {
            return Ok(Some(Decision::Collect(basis)));
        }
        if facts.ruling.is_some() {
            return Ok(None);
        }
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
    if &hold.payer == me {
        let waivers: Vec<WaiverWire> = ledger("waivers_for_hold", hold.hold.clone())?;
        if let Some(waiver) = waivers.into_iter().find(|w| w.portion == share.portion && w.by == share.recipient) {
            return Ok(Some(Decision::Collect(waiver.waiver)));
        }
        if let Some((version, cancellation)) = favor(&DisputeOutcome::FavorRequester) {
            if cancellation != Some(Cancellation::ByCustomer) && facts.receipt.is_none() {
                return Ok(Some(Decision::Collect(version)));
            }
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
fn sweep(days: i64) -> u32 {
    candidates(days).unwrap_or_default().iter().map(|order| settle(order).unwrap_or(0)).sum()
}

use crate::order_queues::QueueOwnerExt;

/// The window a regular sweep covers. A ruling can come later than this;
/// its signal triggers a longer sweep (`settle_soon`).
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
/// until it's settled something; the regular sweep covers anything later.
#[hdk_extern(infallible)]
pub fn settle_soon(previous: Option<Schedule>) -> Option<Schedule> {
    let settled = sweep(SIGNALLED_SWEEP_DAYS) > 0;
    let next = match previous {
        Some(Schedule::Ephemeral(after)) => after * 2,
        _ => FIRST_RETRY,
    };
    (!settled && next <= LAST_RETRY).then_some(Schedule::Ephemeral(next))
}
