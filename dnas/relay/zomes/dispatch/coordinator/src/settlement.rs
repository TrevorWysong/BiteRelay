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
use dispatch_integrity::lineage;
use relay_coordinator_support::{decode_or, guest, original_action_of};

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

/// What the caller can still set aside: their balance, plus how far below
/// zero the network lets it go.
pub(crate) fn spendable() -> ExternResult<i128> {
    let me = agent_info()?.agent_initial_pubkey;
    let balance: i64 = ledger("get_balance", me)?;
    Ok(i128::from(balance) + i128::from(relay_governance::credit_limit_cents()))
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
    find_hold(order, &purpose, payer)?.map(Some).ok_or(guest("This order's payment hasn't been set aside yet. Try again in a moment."))
}

// --- what's known about an order, for settling it ---

/// How far an order had got when it was cancelled -- mirrors
/// `ledger_integrity::Stage`.
#[derive(PartialEq, Eq)]
enum Stage {
    Waiting,
    Accepted,
    DriverAssigned,
    AtStore,
    Other,
}

/// An order's cancellation, as its holds turn on it -- mirrors
/// `ledger_integrity::Cancelled`.
struct Cancelled {
    version: ActionHash,
    by: Cancellation,
    from: Stage,
    cooking: bool,
    bid: Option<ActionHash>,
    liable: Option<ActionHash>,
}

/// A driver leaving before pickup.
struct Release {
    version: ActionHash,
    bid: ActionHash,
    /// They'd committed and the store had started cooking: they answer for
    /// the food until another driver is confirmed.
    liable: bool,
    /// They were calling the store late: they leave paid in full by it.
    store_late: bool,
    /// They left from the counter, checked in: their collateral is theirs.
    at_store: bool,
}

struct Facts {
    /// The store's decisions (see `issues`).
    decisions: crate::issues::Decisions,
    cancellation: Option<Cancelled>,
    releases: Vec<Release>,
    /// The store confirming a later driver: the version, and each bid that
    /// left before it, now clear.
    replaced: Vec<(ActionHash, ActionHash)>,
    /// Whether the order is over: delivered, collected or cancelled.
    finished: bool,
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

fn delivery_stage(status: &DeliveryStatus) -> Stage {
    match status {
        DeliveryStatus::Scheduled | DeliveryStatus::Placed => Stage::Waiting,
        DeliveryStatus::Open | DeliveryStatus::Collecting => Stage::Accepted,
        DeliveryStatus::BidAccepted | DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed => Stage::DriverAssigned,
        DeliveryStatus::DriverAtStore => Stage::AtStore,
        _ => Stage::Other,
    }
}

fn facts(order: &ActionHash) -> ExternResult<Option<Facts>> {
    let all = versions(order)?;
    let Some(original) = all.first() else { return Ok(None) };
    let delivery = decode_or::<DeliveryOrder>(original).is_some();
    let mut facts = Facts { decisions: crate::issues::decisions_of(order)?, cancellation: None, releases: Vec::new(), replaced: Vec::new(), finished: false };
    let prior_of = |record: &Record| match &record.action().data {
        ActionData::Update(update) => all.iter().find(|r| r.action_address() == &update.original_action_address),
        _ => None,
    };
    for record in &all {
        let prior = prior_of(record);
        if !delivery {
            let Some(o) = decode_or::<PickupOrder>(record) else { continue };
            facts.finished |= o.status.is_terminal();
            let from = prior.and_then(decode_or::<PickupOrder>).map(|p| match p.status {
                PickupStatus::Placed => Stage::Waiting,
                PickupStatus::MerchantConfirmed | PickupStatus::ReadyForPickup => Stage::Accepted,
                _ => Stage::Other,
            });
            if let (Some(by), Some(from)) = (o.cancellation, from) {
                let cooking = from == Stage::Accepted;
                facts.cancellation = Some(Cancelled { version: record.action_address().clone(), by, from, cooking, bid: None, liable: None });
            }
            continue;
        }
        let (Some(version), Some(prior)) = (lineage::Version::of(record.clone()), prior.and_then(|p| lineage::Version::of(p.clone()))) else { continue };
        facts.finished |= version.order.status.is_terminal();
        if let Some(bid) = version.released(&prior) {
            let store_late = lineage::is_store_late_release(&version, &prior)?;
            let at_store = prior.order.status == DeliveryStatus::DriverAtStore;
            facts.releases.push(Release { version: record.action_address().clone(), liable: version.released_liable(&prior).is_some(), store_late, at_store, bid });
        }
        let collecting = version.order.status == DeliveryStatus::Collecting && prior.order.status != DeliveryStatus::Collecting;
        if lineage::confirms_driver(&version, &prior) || collecting {
            let confirmed = version.order.accepted_bid.clone();
            lineage::find_back(version.clone(), |v, p| {
                if let Some(bid) = p.and_then(|p| v.released(p)).filter(|bid| Some(bid) != confirmed.as_ref()) {
                    facts.replaced.push((record.action_address().clone(), bid));
                }
                None::<()>
            })?;
        }
        if let (Some(by), true) = (version.order.cancellation.clone(), prior.order.status != DeliveryStatus::Cancelled) {
            let liable = if by == Cancellation::NoDriver { lineage::liable_release(&prior)?.map(|(_, bid)| bid) } else { None };
            facts.cancellation = Some(Cancelled {
                version: record.action_address().clone(),
                by,
                from: delivery_stage(&prior.order.status),
                cooking: prior.order.ready_by.is_some(),
                bid: prior.order.accepted_bid.clone(),
                liable,
            });
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
struct ForfeitWire {
    hold: ActionHash,
    basis: ActionHash,
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
    /// Concede it, on this basis -- a driver's collateral for an order that
    /// never arrived, or that they left cooking with no driver after them;
    /// it frees them to carry another.
    Forfeit(ActionHash),
}

/// The rules in `ledger_integrity::validate_collect`, from the caller's
/// side: what they're owed, and on what -- or, where they're owed nothing
/// and the order's over, giving it back.
fn decide(me: &AgentPubKey, hold: &HoldWire, share: &ShareWire, facts: &Facts) -> Option<Decision> {
    let recipient = &share.recipient == me;
    let payer = &hold.payer == me;
    let hold_bid = match &hold.purpose {
        HoldPurpose::Food => None,
        HoldPurpose::DriverPay { bid } | HoldPurpose::Subsidy { bid } | HoldPurpose::Collateral { bid } => Some(bid),
    };
    let ours = |bid: &Option<ActionHash>| hold_bid.is_some() && bid.as_ref() == hold_bid;
    let collect = |basis: &ActionHash| Some(Decision::Collect(basis.clone()));
    let d = &facts.decisions;
    let released = facts.releases.iter().find(|r| Some(&r.bid) == hold_bid);
    let cancelled = facts.cancellation.as_ref();
    match (&hold.purpose, share.portion) {
        (HoldPurpose::Food, _) => {
            if let Some((settlement, refund)) = &d.settlement {
                let mine = if recipient { share.amount.saturating_sub(*refund) } else if payer { *refund } else { 0 };
                return (mine > 0).then(|| Decision::Collect(settlement.clone()));
            }
            if let Some((outcome, _)) = &d.not_delivered {
                return payer.then(|| Decision::Collect(outcome.clone()));
            }
            let c = cancelled?;
            match c.by {
                Cancellation::ByCustomer if recipient => Some(if c.cooking && !matches!(c.from, Stage::Waiting | Stage::Other) { Decision::Collect(c.version.clone()) } else { Decision::Waive }),
                Cancellation::NotCollected if recipient => collect(&c.version),
                Cancellation::StoreLate | Cancellation::NoDriver if payer => collect(&c.version),
                Cancellation::ByStore(_) | Cancellation::StoreDidNotRespond if recipient => Some(Decision::Waive),
                _ => None,
            }
        }
        (HoldPurpose::DriverPay { .. } | HoldPurpose::Subsidy { .. }, portion) => {
            if let Some((outcome, bid)) = &d.delivered {
                if ours(bid) {
                    // The driver is paid; the store's late cover goes back.
                    return match portion {
                        Portion::LateCover => payer.then(|| Decision::Collect(outcome.clone())),
                        _ => recipient.then(|| Decision::Collect(outcome.clone())),
                    };
                }
            }
            if let Some((outcome, bid)) = &d.not_delivered {
                if ours(bid) {
                    return payer.then(|| Decision::Collect(outcome.clone()));
                }
            }
            if let Some(release) = released {
                // Called late, the store pays them in full; otherwise what
                // was set aside for them goes back.
                if release.store_late && matches!(hold.purpose, HoldPurpose::Subsidy { .. }) {
                    return recipient.then(|| Decision::Collect(release.version.clone()));
                }
                return if payer { collect(&release.version) } else { recipient.then_some(Decision::Waive) };
            }
            let c = cancelled.filter(|c| ours(&c.bid))?;
            let store_fee = matches!(hold.purpose, HoldPurpose::Subsidy { .. });
            match (&c.by, store_fee) {
                (Cancellation::StoreLate, false) if payer => collect(&c.version),
                (Cancellation::StoreLate, true) if recipient => collect(&c.version),
                (Cancellation::ByStore(_), true) if recipient && c.from == Stage::AtStore => collect(&c.version),
                (Cancellation::ByCustomer, false) if recipient && portion == Portion::Fee && matches!(c.from, Stage::DriverAssigned | Stage::AtStore) => collect(&c.version),
                _ if recipient => Some(Decision::Waive),
                _ => None,
            }
        }
        (HoldPurpose::Collateral { .. }, _) => {
            if let Some((outcome, bid)) = &d.delivered {
                if ours(bid) {
                    return payer.then(|| Decision::Collect(outcome.clone()));
                }
            }
            if let Some((outcome, bid)) = &d.not_delivered {
                if ours(bid) {
                    return if recipient { collect(outcome) } else { payer.then(|| Decision::Forfeit(outcome.clone())) };
                }
            }
            if let Some((version, _)) = facts.replaced.iter().find(|(_, bid)| Some(bid) == hold_bid) {
                return payer.then(|| Decision::Collect(version.clone()));
            }
            if let Some(release) = released.filter(|r| r.at_store) {
                return payer.then(|| Decision::Collect(release.version.clone()));
            }
            if let Some(c) = cancelled.filter(|c| matches!(c.by, Cancellation::ByStore(_))) {
                return payer.then(|| Decision::Collect(c.version.clone()));
            }
            if let Some(c) = cancelled {
                if c.by == Cancellation::StoreLate && ours(&c.bid) {
                    return payer.then(|| Decision::Collect(c.version.clone()));
                }
                if c.by == Cancellation::NoDriver && ours(&c.liable) {
                    return if recipient { collect(&c.version) } else { payer.then(|| Decision::Forfeit(c.version.clone())) };
                }
            }
            // The store gives back the collateral of a driver who doesn't
            // answer for the food: one who left before it was cooking, or
            // any whose order ended another way.
            let not_liable = released.is_some_and(|r| !r.liable) || facts.finished;
            (recipient && not_liable).then_some(Decision::Waive)
        }
    }
}

/// A part its recipient has given back, for its payer to collect.
fn waived(hold: &HoldWire, share: &ShareWire) -> ExternResult<Option<Decision>> {
    let waivers: Vec<WaiverWire> = ledger("waivers_for_hold", hold.hold.clone())?;
    Ok(waivers.into_iter().find(|w| w.portion == share.portion && w.by == share.recipient).map(|w| Decision::Collect(w.waiver)))
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
            let decision = match decide(&me, hold, share, &facts) {
                None if hold.payer == me => waived(hold, share)?,
                decided => decided,
            };
            let outcome = match decision {
                Some(Decision::Collect(basis)) => ledger::<_, ActionHash>("collect", CollectWire { hold: hold.hold.clone(), portion: share.portion, basis }).map(|_| ()),
                Some(Decision::Waive) => ledger::<_, ActionHash>("waive", DecideWire { hold: hold.hold.clone(), portion: share.portion }).map(|_| {
                    if !returned.contains(&hold.payer) {
                        returned.push(hold.payer.clone());
                    }
                }),
                Some(Decision::Forfeit(basis)) => ledger::<_, ActionHash>("forfeit", ForfeitWire { hold: hold.hold.clone(), basis }).map(|_| ()),
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
    candidates(days).unwrap_or_default().into_iter().map(|order| relay_coordinator_support::isolated::<_, u32>("settle_order", order).unwrap_or(0)).sum()
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
