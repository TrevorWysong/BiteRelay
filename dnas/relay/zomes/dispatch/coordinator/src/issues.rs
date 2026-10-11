//! How an order settles once it's out of the kitchen: the customer's
//! reports of missing or wrong items, the store's answers, and the store's
//! decisions -- the order's outcome, and its settlement of the food. The
//! model and its rules are `dispatch_types::issues` and
//! `dispatch_integrity`'s; this is the app side of them.
//!
//! The store's conductor makes its decisions on its own, as part of its
//! settlement sweep (`decide_order`): *delivered* as soon as the order is
//! completed on proof; *not delivered* once the customer's claim has stood
//! for a while with no delivery; the settlement once the customer's report
//! window has run, refunding what the store accepted or never answered.

use crate::orders::{record_reputation_event, ReputationEventKindWire, ReputationTargetWire};
use crate::settlement::find_hold;
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, open_chunked, original_action_of, resolve_latest, seal_chunked};

fn guest(message: impl Into<String>) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message.into()))
}

// --- the order, as issues need it ---

/// An order's parties and its lines, each priced as ordered.
struct Priced {
    requester: AgentPubKey,
    merchant: AgentPubKey,
    order_total: u64,
    lines: Vec<(ActionHash, u64, u32)>,
    names: Vec<String>,
}

/// One line of an order, as reports are made against it.
#[derive(Serialize, Deserialize, Debug)]
pub struct IssueItem {
    pub item_ref: ActionHash,
    pub name: String,
    pub unit_price_cents: u64,
    pub quantity: u32,
}

/// What reports on an order are judged against: its lines, and what the
/// customer paid for the food.
#[derive(Serialize, Deserialize, Debug)]
pub struct IssueItems {
    pub order_total: u64,
    pub lines: Vec<IssueItem>,
}

/// An order's items as reports are made against them -- public, as the
/// order's lines are.
#[hdk_extern]
pub fn get_issue_items(order: ActionHash) -> ExternResult<IssueItems> {
    let terms = priced(&original_action_of(order)?)?;
    let lines = terms.lines.into_iter().zip(terms.names).map(|((item_ref, unit_price_cents, quantity), name)| IssueItem { item_ref, name, unit_price_cents, quantity }).collect();
    Ok(IssueItems { order_total: terms.order_total, lines })
}

fn priced(order: &ActionHash) -> ExternResult<Priced> {
    let record = get(order.clone(), GetOptions::default())?.ok_or(guest("order not found"))?;
    let (requester, merchant, order_total, lines) = match (decode_or::<DeliveryOrder>(&record), decode_or::<PickupOrder>(&record)) {
        (Some(o), _) => (o.requester, o.merchant, o.order_total, o.lines),
        (None, Some(o)) => (o.requester, o.merchant, o.order_total, o.lines),
        _ => return Err(guest("that isn't an order")),
    };
    let mut out = Vec::with_capacity(lines.len());
    let mut names = Vec::with_capacity(lines.len());
    for line in lines {
        let version = get(line.priced_version, GetOptions::default())?.ok_or(guest("an item on this order couldn't be found"))?;
        let (price, name) = match (decode_or::<catalog_types::MenuItem>(&version), decode_or::<catalog_types::GoodieBag>(&version)) {
            (Some(item), _) => (item.price_cents, item.name),
            (None, Some(bag)) => (bag.price_cents, bag.title),
            _ => return Err(guest("an order line isn't priced from an item")),
        };
        out.push((line.item_ref, price, line.quantity));
        names.push(name);
    }
    Ok(Priced { requester, merchant, order_total, lines: out, names })
}

// --- the customer ---

#[derive(Serialize, Deserialize, Debug)]
pub struct ReportIssueInput {
    pub order: ActionHash,
    pub lines: Vec<IssueLine>,
    pub note: String,
    /// An inline image, or empty for none.
    #[serde(default)]
    pub photo_data_uri: String,
}

/// The customer reporting items missing or wrong. Reported before the store
/// settles the order, it's refunded unless the store declines it.
#[hdk_extern]
pub fn report_issue(input: ReportIssueInput) -> ExternResult<Record> {
    let order = original_action_of(input.order)?;
    let terms = priced(&order)?;
    if terms.requester != agent_info()?.agent_initial_pubkey {
        return Err(guest("only the order's customer can report a problem with it"));
    }
    if decisions_of(&order)?.settlement.is_some() {
        return Err(guest("The store has already settled this order."));
    }
    // Each item reported once -- validation's rule, told first.
    let reported: Vec<ActionHash> = get_issues_for_order(order.clone())?.into_iter().flat_map(|view| view.lines.into_iter().map(|line| line.item_ref)).collect();
    if input.lines.iter().any(|line| reported.contains(&line.item_ref)) {
        return Err(guest("You've already reported a problem with one of these items."));
    }
    // The version showing they have it -- validation's rule, told first.
    let latest = resolve_latest(order.clone())?;
    let received = match (decode_or::<DeliveryOrder>(&latest), decode_or::<PickupOrder>(&latest)) {
        (Some(delivery), _) => delivery.status == DeliveryStatus::Delivered,
        (None, Some(pickup)) => pickup.status == PickupStatus::PickedUp,
        _ => false,
    };
    if !received {
        return Err(guest("You can report a problem once you have your order."));
    }
    crate::orders::check_note(&input.note)?;
    if let Some(problem) = relay_integrity_support::image_problem(&input.photo_data_uri) {
        return Err(guest(problem));
    }
    let evidence = IssueEvidence { note: input.note, photo_data_uri: input.photo_data_uri };
    let issue = ItemIssue {
        order: order.clone(),
        received: latest.action_address().clone(),
        lines: input.lines,
        sealed_for_store: seal_chunked(&terms.merchant, &evidence)?,
    };
    let hash = create_entry(&EntryTypes::ItemIssue(issue))?;
    create_link(order.clone(), hash.clone(), LinkTypes::OrderToIssue, ())?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::IssueReported { order_hash: order }, vec![terms.merchant]);
    get(hash, GetOptions::local())?.ok_or(guest("could not read back the report"))
}

// --- the store ---

#[derive(Serialize, Deserialize, Debug)]
pub struct RespondToIssueInput {
    pub issue: ActionHash,
    pub accept: bool,
}

/// The store accepting an issue (the customer is refunded when it settles)
/// or declining it (they aren't). The store has the final say. Once per
/// issue.
#[hdk_extern]
pub fn respond_to_issue(input: RespondToIssueInput) -> ExternResult<Record> {
    let record = get(input.issue.clone(), GetOptions::default())?.ok_or(guest("report not found"))?;
    let issue = decode_or::<ItemIssue>(&record).ok_or(guest("that isn't a report"))?;
    if decisions_of(&issue.order)?.settlement.is_some() {
        return Err(guest("This order is already settled."));
    }
    let hash = create_entry(&EntryTypes::IssueResponse(IssueResponse { issue: input.issue.clone(), accept: input.accept }))?;
    create_link(input.issue, hash.clone(), LinkTypes::IssueToResponse, ())?;
    get(hash, GetOptions::local())?.ok_or(guest("could not read back the answer"))
}

// --- reading ---

/// One report, as its order's parties see it.
#[derive(Serialize, Deserialize, Debug)]
pub struct IssueView {
    pub issue: ActionHash,
    pub reported_at: Timestamp,
    pub lines: Vec<IssueLine>,
    /// What it's worth of what the customer paid.
    pub value: u64,
    /// The store's answer: accepted, declined, or not yet.
    pub accepted: Option<bool>,
    /// The note and photo, for the customer and the store.
    pub evidence: Option<IssueEvidence>,
}

/// Every report on an order, with the store's answer and its worth.
#[hdk_extern]
pub fn get_issues_for_order(order: ActionHash) -> ExternResult<Vec<IssueView>> {
    let order = original_action_of(order)?;
    let terms = priced(&order)?;
    let me = agent_info()?.agent_initial_pubkey;
    let now = sys_time()?;
    let mut views = Vec::new();
    for link in get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToIssue)?, GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash.clone(), GetOptions::default())? else { continue };
        let Some(issue) = decode_or::<ItemIssue>(&record).filter(|i| i.order == order && record.action().author() == &terms.requester) else { continue };
        // A report dated ahead of this clock isn't reported yet: counting it
        // would let a customer hold a settlement back, or have one cite a
        // report the store can't answer yet (validation refuses that).
        if record.action().timestamp() > now {
            continue;
        }
        let claimed: Vec<(ActionHash, u32)> = issue.lines.iter().map(|l| (l.item_ref.clone(), l.quantity)).collect();
        let evidence: Option<IssueEvidence> = if me == terms.requester {
            open_chunked(&terms.merchant, &issue.sealed_for_store)?
        } else if me == terms.merchant {
            open_chunked(&terms.requester, &issue.sealed_for_store)?
        } else {
            None
        };
        views.push(IssueView {
            issue: hash.clone(),
            reported_at: record.action().timestamp(),
            value: claimed_value(&terms.lines, terms.order_total, &claimed),
            accepted: store_answer(&hash, &terms.merchant)?,
            evidence: evidence.filter(|e| relay_integrity_support::image_problem(&e.photo_data_uri).is_none()),
            lines: issue.lines,
        });
    }
    views.sort_by_key(|v| v.reported_at);
    Ok(views)
}

/// The store's answer to an issue, if it's given one.
fn store_answer(issue: &ActionHash, merchant: &AgentPubKey) -> ExternResult<Option<bool>> {
    for link in get_links(LinkQuery::try_new(issue.clone(), LinkTypes::IssueToResponse)?, GetStrategy::default())? {
        if &link.author != merchant {
            continue;
        }
        let Some(hash) = link.target.into_action_hash() else { continue };
        if let Some(response) = get(hash, GetOptions::default())?.and_then(|r| decode_or::<IssueResponse>(&r)) {
            return Ok(Some(response.accept));
        }
    }
    Ok(None)
}

// --- the store's decisions ---

/// The store's decisions about an order, as its links record them.
#[derive(Debug, Default)]
pub(crate) struct Decisions {
    /// Its outcome: delivered -- and the bid that delivered it.
    pub delivered: Option<(ActionHash, Option<ActionHash>)>,
    /// Its outcome: never delivered -- and the bid that had it.
    pub not_delivered: Option<(ActionHash, Option<ActionHash>)>,
    /// Its settlement of the food, and the refund it names.
    pub settlement: Option<(ActionHash, u64)>,
}

/// The store's decisions about `order` (its original action) -- only ever
/// the store's own: anyone else's link is ignored.
pub(crate) fn decisions_of(order: &ActionHash) -> ExternResult<Decisions> {
    let (_, merchant) = parties_of(order)?;
    let mut decisions = Decisions::default();
    for link in get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToDecision)?, GetStrategy::default())? {
        if link.author != merchant {
            continue;
        }
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash.clone(), GetOptions::default())? else { continue };
        if let Some(outcome) = decode_or::<OrderOutcome>(&record).filter(|o| &o.order == order) {
            let bid_at = |version: &ActionHash| get(version.clone(), GetOptions::default()).ok().flatten().and_then(|r| decode_or::<DeliveryOrder>(&r)).and_then(|o| o.accepted_bid);
            match outcome.outcome {
                Outcome::Delivered { proof } => decisions.delivered = Some((hash, bid_at(&proof))),
                Outcome::NotDelivered { claim } => decisions.not_delivered = Some((hash, bid_at(&claim))),
            }
        } else if let Some(settlement) = decode_or::<ItemSettlement>(&record).filter(|s| &s.order == order) {
            decisions.settlement = Some((hash, settlement.refund));
        }
    }
    Ok(decisions)
}

/// An order's customer and store.
fn parties_of(order: &ActionHash) -> ExternResult<(AgentPubKey, AgentPubKey)> {
    let record = get(order.clone(), GetOptions::default())?.ok_or(guest("order not found"))?;
    match (decode_or::<DeliveryOrder>(&record), decode_or::<PickupOrder>(&record)) {
        (Some(o), _) => Ok((o.requester, o.merchant)),
        (None, Some(o)) => Ok((o.requester, o.merchant)),
        _ => Err(guest("that isn't an order")),
    }
}

/// How an order stands with its store, for its screens.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct OrderDecisions {
    /// The store decided it was delivered.
    pub delivered: bool,
    /// The store decided it never was: the customer is refunded.
    pub not_delivered: bool,
    /// The store has settled the food: the refund it named.
    pub refund: Option<u64>,
    /// When the customer's report window ends, once they have the order --
    /// when the store's app settles it.
    pub reports_until: Option<Timestamp>,
    /// When the store's app decides an unanswered claim, if there is one.
    pub claim_decided_after: Option<Timestamp>,
}

/// How `order` stands with its store.
#[hdk_extern]
pub fn get_order_decisions(order: ActionHash) -> ExternResult<OrderDecisions> {
    let order = original_action_of(order)?;
    let decisions = decisions_of(&order)?;
    let latest = resolve_latest(order.clone())?;
    let at = latest.action().timestamp().as_micros();
    let (has_it, claimed) = match (decode_or::<DeliveryOrder>(&latest), decode_or::<PickupOrder>(&latest)) {
        (Some(o), _) => (matches!(o.status, DeliveryStatus::Delivered | DeliveryStatus::Collected), o.status == DeliveryStatus::Disputed),
        (None, Some(o)) => (o.status == PickupStatus::PickedUp, false),
        _ => (false, false),
    };
    Ok(OrderDecisions {
        delivered: decisions.delivered.is_some(),
        not_delivered: decisions.not_delivered.is_some(),
        refund: decisions.settlement.map(|(_, refund)| refund),
        reports_until: has_it.then(|| Timestamp::from_micros(at + relay_governance::report_window().as_micros() as i64)),
        claim_decided_after: (claimed && decisions.not_delivered.is_none()).then(|| Timestamp::from_micros(at + claim_grace_micros())),
    })
}

/// `relay_governance::claim_grace`, in microseconds. The store can decide
/// sooner (`decide_not_delivered`).
fn claim_grace_micros() -> i64 {
    relay_governance::claim_grace().as_micros() as i64
}

/// `relay_governance::answer_grace`, in microseconds.
fn answer_grace_micros() -> i64 {
    relay_governance::answer_grace().as_micros() as i64
}

/// The refund the store's answers add up to: every report it accepted or
/// never answered. The store has the final say -- one it declined isn't
/// refunded -- as it would if you ordered from it directly.
fn refund_owed(terms: &Priced, issues: &[IssueView]) -> (Vec<ActionHash>, u64) {
    let refunded: Vec<&IssueView> = issues.iter().filter(|i| i.accepted != Some(false)).collect();
    let claimed: Vec<(ActionHash, u32)> = refunded.iter().flat_map(|i| i.lines.iter().map(|l| (l.item_ref.clone(), l.quantity))).collect();
    (refunded.iter().map(|i| i.issue.clone()).collect(), claimed_value(&terms.lines, terms.order_total, &claimed))
}

/// Has the store's conductor make its decisions on `order`, in a call of its
/// own -- a decision that doesn't validate yet must never undo the
/// caller's. Does nothing unless the caller is the order's store.
pub(crate) fn decide_as_store(order: &ActionHash) {
    let is_store = parties_of(order).ok().zip(agent_info().ok()).is_some_and(|((_, merchant), me)| merchant == me.agent_initial_pubkey);
    if let (true, Ok(zome)) = (is_store, zome_info().map(|z| z.name)) {
        let _ = call(CallTargetCell::Local, zome, "decide_order".into(), None, order.clone());
    }
}

/// A store decision, to write.
#[derive(Serialize, Deserialize, Debug)]
pub enum DecisionWire {
    Outcome(OrderOutcome),
    Settlement(ItemSettlement),
}

/// Writes one of the caller's decisions, linked under its order -- in a zome
/// call of its own (`record_decision`), so it's committed before anything
/// that cites it is written.
#[hdk_extern]
pub fn write_decision(decision: DecisionWire) -> ExternResult<ActionHash> {
    let (order, entry) = match decision {
        DecisionWire::Outcome(outcome) => (outcome.order.clone(), EntryTypes::OrderOutcome(outcome)),
        DecisionWire::Settlement(settlement) => (settlement.order.clone(), EntryTypes::ItemSettlement(settlement)),
    };
    let hash = create_entry(&entry)?;
    create_link(order, hash.clone(), LinkTypes::OrderToDecision, ())?;
    Ok(hash)
}

fn record_decision(decision: DecisionWire) -> ExternResult<ActionHash> {
    match call(CallTargetCell::Local, zome_info()?.name, "write_decision".into(), None, decision)? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e)),
        other => Err(guest(format!("couldn't record the decision: {other:?}"))),
    }
}

/// The caller (an order's store) making whatever decisions on it are due:
/// its outcome, then its settlement. Returns whether it decided anything.
#[hdk_extern]
pub fn decide_order(order: ActionHash) -> ExternResult<bool> {
    let order = original_action_of(order)?;
    let me = agent_info()?.agent_initial_pubkey;
    let (requester, merchant) = parties_of(&order)?;
    if me != merchant {
        return Ok(false);
    }
    let now = sys_time()?.as_micros();
    let mut decisions = decisions_of(&order)?;
    let latest = resolve_latest(order.clone())?;

    // When the customer had the order, if they do: the basis a settlement
    // cites, and when its report window started.
    let has_it = match (decode_or::<DeliveryOrder>(&latest), decode_or::<PickupOrder>(&latest)) {
        (Some(delivery), _) => {
            if decisions.delivered.is_none() && decisions.not_delivered.is_none() {
                match delivery.status {
                    DeliveryStatus::Delivered => {
                        let hash = record_decision(DecisionWire::Outcome(OrderOutcome { order: order.clone(), outcome: Outcome::Delivered { proof: latest.action_address().clone() } }))?;
                        // A customer who claimed it never came, and it had.
                        if came_out_of_claim(&latest)? {
                            record_reputation_event(&requester, ReputationTargetWire::Customer(requester.clone()), order.clone(), ReputationEventKindWire::DisputeResolvedAgainst, hash.clone())?;
                        }
                        // The driver's completed delivery, on the store's
                        // word -- and they collect their pay on it.
                        if let Some(bid) = delivery.accepted_bid.as_ref().and_then(|b| get(b.clone(), GetOptions::default()).ok().flatten()).and_then(|r| decode_or::<Bid>(&r)) {
                            record_reputation_event(&bid.bidder, ReputationTargetWire::Driver(bid.bidder.clone()), order.clone(), ReputationEventKindWire::OrderCompleted, hash.clone())?;
                            let _ = send_remote_signal(crate::signals::RemoteSignal::Returned { order_hash: order.clone() }, vec![bid.bidder]);
                        }
                        // Finished: off every queue, the driver's included.
                        crate::order_queues::retire(&crate::OrderParties::delivery(&order, &delivery)?)?;
                        decisions.delivered = Some((hash, delivery.accepted_bid.clone()));
                    }
                    DeliveryStatus::Disputed if now >= latest.action().timestamp().as_micros() + claim_grace_micros() => {
                        not_delivered(&order, &latest, &delivery)?;
                        return Ok(true);
                    }
                    _ => {}
                }
            }
            if delivery.status == DeliveryStatus::Collected {
                // Collected from the store: no driver, so nothing to decide
                // but the food -- settled on the collection, as a pickup is.
                Some((latest.action_address().clone(), latest.action().timestamp()))
            } else {
                decisions.delivered.clone().map(|(outcome, _)| (outcome, latest.action().timestamp()))
            }
        }
        (None, Some(pickup)) => (pickup.status == PickupStatus::PickedUp && latest.action().author() == &requester).then(|| (latest.action_address().clone(), latest.action().timestamp())),
        _ => None,
    };

    // The settlement, once the customer's report window has run and every
    // report has had its grace.
    let Some((basis, since)) = has_it else { return Ok(false) };
    if decisions.settlement.is_some() || now < since.as_micros() + relay_governance::report_window().as_micros() as i64 {
        return Ok(false);
    }
    let terms = priced(&order)?;
    // Nothing to settle for food nobody paid for (an order from the
    // customer's own store).
    if find_hold(&order, &HoldPurpose::Food, &requester)?.is_none() {
        return Ok(false);
    }
    let issues = get_issues_for_order(order.clone())?;
    if issues.iter().any(|i| i.accepted.is_none() && now < i.reported_at.as_micros() + answer_grace_micros()) {
        return Ok(false);
    }
    let (cited, refund) = refund_owed(&terms, &issues);
    record_decision(DecisionWire::Settlement(ItemSettlement { order: order.clone(), basis, issues: cited, refund }))?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::Returned { order_hash: order }, vec![requester]);
    Ok(true)
}

/// Whether a delivered version came out of the customer's claim that it
/// never arrived.
fn came_out_of_claim(delivered: &Record) -> ExternResult<bool> {
    let ActionData::Update(update) = &delivered.action().data else { return Ok(false) };
    Ok(get(update.original_action_address.clone(), GetOptions::default())?.and_then(|r| decode_or::<DeliveryOrder>(&r)).is_some_and(|prior| prior.status == DeliveryStatus::Disputed))
}

/// The store deciding the order never arrived, on the customer's claim
/// (`claim`): everyone's money goes back, and the driver's collateral pays
/// the store for the food -- recorded against the driver.
fn not_delivered(order: &ActionHash, claim: &Record, delivery: &DeliveryOrder) -> ExternResult<ActionHash> {
    let hash = record_decision(DecisionWire::Outcome(OrderOutcome { order: order.clone(), outcome: Outcome::NotDelivered { claim: claim.action_address().clone() } }))?;
    if let Some(bid_ref) = &delivery.accepted_bid {
        if let Some(bid) = get(bid_ref.clone(), GetOptions::default())?.and_then(|r| decode_or::<Bid>(&r)) {
            let driver = bid.bidder;
            record_reputation_event(&driver, ReputationTargetWire::Driver(driver.clone()), order.clone(), ReputationEventKindWire::DisputeResolvedAgainst, hash.clone())?;
            record_reputation_event(&driver, ReputationTargetWire::Driver(driver.clone()), order.clone(), ReputationEventKindWire::CollateralForfeited { amount: bid.collateral }, hash.clone())?;
            let _ = send_remote_signal(crate::signals::RemoteSignal::Returned { order_hash: order.clone() }, vec![delivery.requester.clone(), driver]);
        }
    }
    // Finished: off every queue, the driver's included.
    crate::order_queues::retire(&crate::OrderParties::delivery(order, delivery)?)?;
    Ok(hash)
}

/// The store deciding, now, that a claimed order never arrived -- rather
/// than waiting out the claim's grace.
#[hdk_extern]
pub fn decide_not_delivered(order: ActionHash) -> ExternResult<ActionHash> {
    let order = original_action_of(order)?;
    let (_, merchant) = parties_of(&order)?;
    if merchant != agent_info()?.agent_initial_pubkey {
        return Err(guest("only the order's store decides this"));
    }
    let decisions = decisions_of(&order)?;
    if decisions.delivered.is_some() || decisions.not_delivered.is_some() {
        return Err(guest("This order's outcome is already decided."));
    }
    let latest = resolve_latest(order.clone())?;
    let delivery = decode_or::<DeliveryOrder>(&latest).filter(|o| o.status == DeliveryStatus::Disputed).ok_or(guest("The customer hasn't said it never arrived."))?;
    not_delivered(&order, &latest, &delivery)
}
