//! Missing and wrong items: the customer's report, the store's answer, and
//! the issue window the order's closing arbitrator keeps. The model and its
//! rules are `dispatch_types::issues` and `dispatch_integrity`'s; this is the
//! app side of them.

use crate::settlement::find_hold;
use attestation_types::{Leg, LegKind, ReceiptAttestation};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, open, open_my_seal, original_action_of, resolve_latest, seal, seal_to_arbitrators};

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

/// The customer reporting items missing or wrong. Reported before the
/// order's issue window closes, it's refunded at the close unless the store
/// declines it.
#[hdk_extern]
pub fn report_issue(input: ReportIssueInput) -> ExternResult<Record> {
    let order = original_action_of(input.order)?;
    let terms = priced(&order)?;
    if terms.requester != agent_info()?.agent_initial_pubkey {
        return Err(guest("only the order's customer can report a problem with it"));
    }
    if relay_governance::closing_arbitrator(&order).is_none() {
        return Err(guest("This network has no arbitrators to settle a report."));
    }
    if window_of(&order)?.closed.is_some() {
        return Err(guest("This order's window for reporting problems has closed."));
    }
    if input.note.chars().count() > 1_000 {
        return Err(guest("a note may be at most 1,000 characters"));
    }
    if let Some(problem) = relay_integrity_support::image_problem(&input.photo_data_uri) {
        return Err(guest(problem));
    }
    let evidence = IssueEvidence { note: input.note, photo_data_uri: input.photo_data_uri };
    let issue = ItemIssue {
        order: order.clone(),
        lines: input.lines,
        sealed_for_store: seal(&terms.merchant, &evidence)?,
        sealed_for_arbitrators: seal_to_arbitrators(&relay_governance::arbitrator_roster(), &evidence)?,
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

/// The store accepting an issue (the customer is refunded at the close) or
/// declining it (they aren't). The store has the final say. Once per issue.
#[hdk_extern]
pub fn respond_to_issue(input: RespondToIssueInput) -> ExternResult<Record> {
    let record = get(input.issue.clone(), GetOptions::default())?.ok_or(guest("report not found"))?;
    let issue = decode_or::<ItemIssue>(&record).ok_or(guest("that isn't a report"))?;
    if window_of(&issue.order)?.closed.is_some() {
        return Err(guest("This order's window for problems has closed."));
    }
    let hash = create_entry(&EntryTypes::IssueResponse(IssueResponse { issue: input.issue.clone(), accept: input.accept }))?;
    create_link(input.issue, hash.clone(), LinkTypes::IssueToResponse, ())?;
    get(hash, GetOptions::local())?.ok_or(guest("could not read back the answer"))
}

// --- reading ---

/// One report, as its order's parties and arbitrators see it.
#[derive(Serialize, Deserialize, Debug)]
pub struct IssueView {
    pub issue: ActionHash,
    pub reported_at: Timestamp,
    pub lines: Vec<IssueLine>,
    /// What it's worth of what the customer paid.
    pub value: u64,
    /// The store's answer: accepted, declined, or not yet.
    pub accepted: Option<bool>,
    /// The note and photo, for whoever can open them (the customer, the
    /// store, an arbitrator).
    pub evidence: Option<IssueEvidence>,
}

/// An order's issue window, as the arbitrator keeping it has recorded it.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct IssueWindowView {
    /// Whether the order has an issue window at all: only on a network with
    /// arbitrators, for an order whose food was paid for.
    pub available: bool,
    pub opened_at: Option<Timestamp>,
    pub closes_at: Option<Timestamp>,
    /// The refund named at the close, once closed.
    pub closed: Option<u64>,
    pub closed_record: Option<ActionHash>,
    pub opened_record: Option<ActionHash>,
}

fn window_of(order: &ActionHash) -> ExternResult<IssueWindowView> {
    let Some(arbitrator) = relay_governance::closing_arbitrator(order) else { return Ok(IssueWindowView::default()) };
    let mut view = IssueWindowView { available: true, ..Default::default() };
    for link in get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToIssueWindow)?, GetStrategy::default())? {
        if link.author != arbitrator {
            continue;
        }
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash.clone(), GetOptions::default())? else { continue };
        if decode_or::<IssueWindowOpened>(&record).is_some_and(|o| &o.order == order) {
            let at = record.action().timestamp();
            view.opened_at = Some(at);
            view.closes_at = Some(Timestamp::from_micros(at.as_micros() + relay_governance::issue_window().as_micros() as i64));
            view.opened_record = Some(hash);
        } else if let Some(closed) = decode_or::<IssueWindowClosed>(&record) {
            view.closed = Some(closed.refund);
            view.closed_record = Some(hash);
        }
    }
    Ok(view)
}

/// An order's issue window -- when it closes, and the refund once it has.
#[hdk_extern]
pub fn get_issue_window(order: ActionHash) -> ExternResult<IssueWindowView> {
    window_of(&original_action_of(order)?)
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
        // would let a customer hold a window open, or close it on a report
        // the store can't answer yet (validation refuses both).
        if record.action().timestamp() > now {
            continue;
        }
        let claimed: Vec<(ActionHash, u32)> = issue.lines.iter().map(|l| (l.item_ref.clone(), l.quantity)).collect();
        let evidence: Option<IssueEvidence> = if me == terms.requester {
            open(&terms.merchant, &issue.sealed_for_store)?
        } else if me == terms.merchant {
            open(&terms.requester, &issue.sealed_for_store)?
        } else {
            open_my_seal(&issue.sealed_for_arbitrators, &terms.requester)?
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

// --- the arbitrator keeping the window ---

/// An order's customer and store.
fn parties_of(order: &ActionHash) -> ExternResult<(AgentPubKey, AgentPubKey)> {
    let record = get(order.clone(), GetOptions::default())?.ok_or(guest("order not found"))?;
    match (decode_or::<DeliveryOrder>(&record), decode_or::<PickupOrder>(&record)) {
        (Some(o), _) => Ok((o.requester, o.merchant)),
        (None, Some(o)) => Ok((o.requester, o.merchant)),
        _ => Err(guest("that isn't an order")),
    }
}

/// Queues a confirmed order under its closing arbitrator, best-effort and
/// in a call of its own: a write that doesn't validate yet must never undo
/// the caller's (a completion, a settlement).
pub(crate) fn queue_for_window(order: &ActionHash) {
    if let Ok(zome) = zome_info().map(|z| z.name) {
        let _ = call(CallTargetCell::Local, zome, "queue_issue_window".into(), None, order.clone());
    }
}

/// Queues `order` under its closing arbitrator. Only its customer or its
/// store may (validation refuses anyone else), so for anyone else this does
/// nothing. Safe to repeat.
#[hdk_extern]
pub fn queue_issue_window(order: ActionHash) -> ExternResult<()> {
    let order = &original_action_of(order)?;
    let Some(arbitrator) = relay_governance::closing_arbitrator(order) else { return Ok(()) };
    let me = agent_info()?.agent_initial_pubkey;
    let (requester, merchant) = parties_of(order)?;
    if me != requester && me != merchant {
        return Ok(());
    }
    let queued = get_links(LinkQuery::try_new(arbitrator.clone(), LinkTypes::ArbitratorToClosingQueue)?, GetStrategy::default())?
        .into_iter()
        .any(|l| l.author == me && l.target.into_action_hash().as_ref() == Some(order));
    if !queued {
        create_link(arbitrator, order.clone(), LinkTypes::ArbitratorToClosingQueue, ())?;
    }
    Ok(())
}

/// What confirmed an order, if anything has: the customer's receipt for the
/// drop-off, the delivery completed on their scanned code, their own update
/// collecting a pickup, or a ruling that it arrived.
fn confirmation_of(order: &ActionHash, requester: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "attestation", "get_legs_for_order".into(), None, order.clone())? else { return Ok(None) };
    let legs: Vec<Record> = io.decode().map_err(|e| wasm_error!(e))?;
    for leg in legs {
        let Some(l) = decode_or::<Leg>(&leg) else { continue };
        if l.kind != LegKind::CustomerHandoff {
            continue;
        }
        let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "attestation", "get_receipt_for_leg".into(), None, leg.action_address().clone())? else { continue };
        let receipt: Option<Record> = io.decode().map_err(|e| wasm_error!(e))?;
        if let Some(receipt) = receipt.filter(|r| r.action().author() == requester && decode_or::<ReceiptAttestation>(r).is_some()) {
            return Ok(Some(receipt.action_address().clone()));
        }
    }
    let latest = resolve_latest(order.clone())?;
    let completed = match (decode_or::<DeliveryOrder>(&latest), decode_or::<PickupOrder>(&latest)) {
        (Some(o), _) if o.status == DeliveryStatus::Delivered && attestation_types::rests_on_scan(&o.delivery_receipts)? => return Ok(Some(latest.action_address().clone())),
        (Some(o), _) => o.status == DeliveryStatus::Delivered,
        (None, Some(o)) => o.status == PickupStatus::PickedUp,
        _ => false,
    };
    let by_ruling_or_customer = relay_governance::is_arbitrator(latest.action().author())? || latest.action().author() == requester;
    Ok((completed && by_ruling_or_customer).then(|| latest.action_address().clone()))
}

/// However late a report comes, the store has at least this long to answer
/// it before the window can close on it -- a report filed in the window's
/// last minute can't be refunded before the store has seen it. Never longer
/// than the window itself.
fn answer_grace_micros() -> i64 {
    (30 * 60 * 1_000_000).min(relay_governance::issue_window().as_micros() as i64)
}

/// Whether `window` can close now: it's run its course, and every report
/// the store hasn't answered has had its grace.
fn ready_to_close(window: &IssueWindowView, issues: &[IssueView], now: Timestamp) -> bool {
    let window_over = window.closes_at.is_some_and(|at| now >= at);
    let graced = issues.iter().filter(|i| i.accepted.is_none()).all(|i| now.as_micros() >= i.reported_at.as_micros() + answer_grace_micros());
    window_over && graced
}

/// The refund the store's answers add up to: every report it accepted or
/// never answered. The store has the final say -- one it declined isn't
/// refunded -- as it would ordering from it directly.
fn refund_owed(order: &ActionHash, issues: Vec<IssueView>) -> ExternResult<(Vec<ActionHash>, u64)> {
    let terms = priced(order)?;
    let refunded: Vec<IssueView> = issues.into_iter().filter(|i| i.accepted != Some(false)).collect();
    let claimed: Vec<(ActionHash, u32)> = refunded.iter().flat_map(|i| i.lines.iter().map(|l| (l.item_ref.clone(), l.quantity))).collect();
    Ok((refunded.into_iter().map(|i| i.issue).collect(), claimed_value(&terms.lines, terms.order_total, &claimed)))
}

fn close(order: &ActionHash, opened: ActionHash, issues: Vec<ActionHash>, refund: u64) -> ExternResult<ActionHash> {
    let hash = create_entry(&EntryTypes::IssueWindowClosed(IssueWindowClosed { opened, issues, refund }))?;
    create_link(order.clone(), hash.clone(), LinkTypes::OrderToIssueWindow, ())?;
    // Everyone on the order hears: the store and the customer collect.
    let terms = priced(order)?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::Returned { order_hash: order.clone() }, vec![terms.requester, terms.merchant]);
    Ok(hash)
}

/// How far back the arbitrator looks for orders waiting on their window.
const QUEUE_DAYS: i64 = 30;

/// The caller (an order's closing arbitrator) opening the windows of the
/// orders queued to it that are now confirmed, and closing those whose
/// window has passed. Returns how many it closed.
#[hdk_extern]
pub fn keep_issue_windows(_: ()) -> ExternResult<u32> {
    let me = agent_info()?.agent_initial_pubkey;
    if !relay_governance::is_arbitrator(&me)? {
        return Ok(0);
    }
    let now = sys_time()?;
    let mut query = LinkQuery::try_new(me.clone(), LinkTypes::ArbitratorToClosingQueue)?;
    query.after = Some(Timestamp::from_micros(now.as_micros() - QUEUE_DAYS * 86_400_000_000));
    let mut orders: Vec<ActionHash> = get_links(query, GetStrategy::default())?.into_iter().filter_map(|l| l.target.into_action_hash()).collect();
    orders.sort();
    orders.dedup();
    let mut closed = 0;
    for order in orders.into_iter().filter(|o| relay_governance::closing_arbitrator(o).as_ref() == Some(&me)) {
        // Each in its own call, so one order's write that doesn't validate
        // yet (its confirmation still gossiping here, say) can't undo the
        // rest.
        if let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, zome_info()?.name, "keep_issue_window".into(), None, order)? {
            if io.decode::<bool>().map_err(|e| wasm_error!(e))? {
                closed += 1;
            }
        }
    }
    Ok(closed)
}

/// The caller (the order's closing arbitrator) opening `order`'s issue
/// window if it's confirmed, or closing it with what the store's answers
/// owe once it's run its course. Returns whether it closed it.
#[hdk_extern]
pub fn keep_issue_window(order: ActionHash) -> ExternResult<bool> {
    let me = agent_info()?.agent_initial_pubkey;
    if relay_governance::closing_arbitrator(&order).as_ref() != Some(&me) {
        return Ok(false);
    }
    let window = window_of(&order)?;
    if window.closed.is_some() {
        return Ok(false);
    }
    let terms = priced(&order)?;
    // Nothing to keep for an order whose food nobody paid for (one from the
    // customer's own store).
    if find_hold(&order, &HoldPurpose::Food, &terms.requester)?.is_none() {
        return Ok(false);
    }
    let Some(opened) = window.opened_record.clone() else {
        if let Some(confirmation) = confirmation_of(&order, &terms.requester)? {
            let hash = create_entry(&EntryTypes::IssueWindowOpened(IssueWindowOpened { order: order.clone(), confirmation }))?;
            create_link(order, hash, LinkTypes::OrderToIssueWindow, ())?;
        }
        return Ok(false);
    };
    let issues = get_issues_for_order(order.clone())?;
    if !ready_to_close(&window, &issues, sys_time()?) {
        return Ok(false);
    }
    let (issues, refund) = refund_owed(&order, issues)?;
    close(&order, opened, issues, refund)?;
    Ok(true)
}
