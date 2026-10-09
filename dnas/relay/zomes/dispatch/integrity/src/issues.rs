//! Validation for missing and wrong items -- see `dispatch_types::issues`
//! for the flow. What it guarantees:
//!
//! - only an order's own customer reports issues with it, only for items on
//!   it, never more units than were ordered;
//! - only its store answers each issue, once;
//! - only the order's closing arbitrator (`relay_governance::
//!   closing_arbitrator`) opens its issue window, once, on a real
//!   confirmation -- and closes it, once, no sooner than the window after
//!   opening it, on its own clock;
//! - a close's refund is never more than the issues it cites are worth of
//!   what the customer paid.

use super::*;
use dispatch_types::{claimed_value, IssueResponse, IssueWindowClosed, IssueWindowOpened, ItemIssue};
use relay_integrity_support::{decode, original_creation};

/// An order's terms an issue is judged against: its parties, and each line
/// as (item, unit price, quantity ordered).
pub(crate) struct OrderForIssues {
    pub requester: AgentPubKey,
    pub merchant: AgentPubKey,
    pub order_total: u64,
    pub lines: Vec<(ActionHash, u64, u32)>,
    pub delivery: bool,
}

/// `order` (its original action), with each line priced from the exact
/// version it was ordered at.
pub(crate) fn order_for_issues(order: &ActionHash) -> ExternResult<Option<OrderForIssues>> {
    if &original_creation(order.clone())? != order {
        return Ok(None);
    }
    let record = must_get_valid_record(order.clone())?;
    let (requester, merchant, order_total, lines, delivery) = if let Some(o) = decode::<DeliveryOrder>(&record) {
        (o.requester, o.merchant, o.order_total, o.lines, true)
    } else if let Some(o) = decode::<PickupOrder>(&record) {
        (o.requester, o.merchant, o.order_total, o.lines, false)
    } else {
        return Ok(None);
    };
    let mut priced = Vec::with_capacity(lines.len());
    for line in lines {
        let version = must_get_valid_record(line.priced_version.clone())?;
        let price = if let Some(item) = decode::<MenuItem>(&version) {
            item.price_cents
        } else if let Some(bag) = decode::<catalog_types::GoodieBag>(&version) {
            bag.price_cents
        } else {
            return Ok(None);
        };
        priced.push((line.item_ref, price, line.quantity));
    }
    Ok(Some(OrderForIssues { requester, merchant, order_total, lines: priced, delivery }))
}

/// Whether `confirmation` confirms `order` reached its customer: their
/// receipt for the drop-off, the delivery completed on their scanned code,
/// their own update collecting a pickup, or an arbitrator's ruling that it
/// was delivered or collected.
pub(crate) fn confirms(order: &ActionHash, terms: &OrderForIssues, confirmation: &ActionHash) -> ExternResult<bool> {
    let record = must_get_valid_record(confirmation.clone())?;
    let author = record.action().author().clone();
    let leg_of_order = |leg: &Leg| -> ExternResult<bool> { Ok(leg.kind == LegKind::CustomerHandoff && &original_creation(leg.order_ref.clone())? == order) };
    if let Some(receipt) = decode::<ReceiptAttestation>(&record) {
        let Some(leg) = decode::<Leg>(&must_get_valid_record(receipt.leg)?) else { return Ok(false) };
        return Ok(author == terms.requester && leg_of_order(&leg)?);
    }
    if &original_creation(confirmation.clone())? != order {
        return Ok(false);
    }
    let (completed, dispute_ref) = if terms.delivery {
        match decode::<DeliveryOrder>(&record) {
            // Completed on the customer's scanned code.
            Some(o) if o.status == DeliveryStatus::Delivered && attestation_types::rests_on_scan(&o.delivery_receipts)? => return Ok(true),
            Some(o) => (o.status == DeliveryStatus::Delivered, o.dispute_ref),
            None => return Ok(false),
        }
    } else {
        match decode::<PickupOrder>(&record) {
            Some(o) => (o.status == PickupStatus::PickedUp, o.dispute_ref),
            None => return Ok(false),
        }
    };
    if !completed {
        return Ok(false);
    }
    if !terms.delivery && author == terms.requester {
        return Ok(true);
    }
    // An arbitrator's ruling that it arrived.
    if !relay_governance::is_arbitrator(&author)? {
        return Ok(false);
    }
    let Some(dispute_ref) = dispute_ref else { return Ok(false) };
    Ok(decode::<Dispute>(&must_get_valid_record(dispute_ref)?).is_some_and(|d| d.status == DisputeStatus::Resolved && d.outcome == Some(DisputeOutcome::FavorProvider)))
}

pub(crate) fn validate_item_issue(issue: &ItemIssue, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let Some(terms) = order_for_issues(&issue.order)? else {
        return invalid("an issue is reported about an order, by its original action");
    };
    if author != &terms.requester {
        return invalid("only the order's customer reports issues with it");
    }
    if issue.lines.is_empty() {
        return invalid("an issue names at least one item");
    }
    for (i, line) in issue.lines.iter().enumerate() {
        if issue.lines[..i].iter().any(|l| l.item_ref == line.item_ref) {
            return invalid("each item appears once in an issue");
        }
        let Some((_, _, ordered)) = terms.lines.iter().find(|(item, _, _)| item == &line.item_ref) else {
            return invalid("an issue names only items on the order");
        };
        if line.quantity == 0 || line.quantity > *ordered {
            return invalid("an issue claims between one and the number ordered of each item");
        }
    }
    if !dispute_types::seals_cover_roster(&issue.sealed_for_arbitrators, &relay_governance::arbitrator_roster()) {
        return invalid("an issue's evidence is sealed once to each arbitrator");
    }
    let bound = relay_integrity_support::MAX_IMAGE_URI_BYTES + 4_096;
    let sizes_ok = issue.sealed_for_store.as_encrypted_data_ref().len() <= bound && issue.sealed_for_arbitrators.iter().all(|s| s.sealed.as_encrypted_data_ref().len() <= bound);
    require(sizes_ok, "an issue's evidence may hold a note and at most one 300KB photo")
}

/// Whether `author` already wrote an entry of `entry_type` on their chain
/// between `since` and `chain_top` for which `matches` holds.
fn already_wrote<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(
    author: &AgentPubKey,
    chain_top: &ActionHash,
    since: Timestamp,
    unit: UnitEntryTypes,
    matches: impl Fn(&T) -> bool,
) -> ExternResult<bool> {
    if must_get_action(chain_top.clone())?.hashed.content.header.timestamp < since {
        return Ok(false);
    }
    let wanted = EntryType::try_from(unit)?;
    for item in must_get_agent_activity(author.clone(), ChainFilter::until_timestamp(chain_top.clone(), since).include_cached_entries())? {
        let ActionData::Create(create) = &item.action.hashed.content.data else { continue };
        if create.entry_type != wanted {
            continue;
        }
        let entry = match item.cached_entry {
            Some(entry) => entry,
            None => must_get_entry(create.entry_hash.clone())?.content,
        };
        let Entry::App(bytes) = entry else { continue };
        if T::try_from(SerializedBytes::from(bytes)).is_ok_and(|e| matches(&e)) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn validate_issue_response(response: &IssueResponse, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let issue_record = must_get_valid_record(response.issue.clone())?;
    let Some(issue) = decode::<ItemIssue>(&issue_record) else { return invalid("a response answers an issue") };
    let Some(terms) = order_for_issues(&issue.order)? else { return invalid("the issue's order is gone") };
    if author != &terms.merchant {
        return invalid("only the order's store answers an issue with it");
    }
    // So the walk below, from the issue's timestamp, sees every answer to
    // it: none can be dated before it.
    if at < issue_record.action().timestamp() {
        return invalid("an answer comes after the issue it answers");
    }
    let Some(prev) = prev_action else { return invalid("a response can't open a chain") };
    let answered = already_wrote::<IssueResponse>(author, prev, issue_record.action().timestamp(), UnitEntryTypes::IssueResponse, |r| r.issue == response.issue)?;
    require(!answered, "a store answers each issue once")
}

pub(crate) fn validate_window_opened(opened: &IssueWindowOpened, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(terms) = order_for_issues(&opened.order)? else { return invalid("an issue window is opened on an order, by its original action") };
    if relay_governance::closing_arbitrator(&opened.order).as_ref() != Some(author) {
        return invalid("only the order's closing arbitrator keeps its issue window");
    }
    if !confirms(&opened.order, &terms, &opened.confirmation)? {
        return invalid("an issue window opens on the order's confirmation");
    }
    // Every opening of this order's window is dated after the order, so the
    // walk back to the order sees all of them -- whatever confirmation each
    // cites. (Two openings would mean two closes, and the store and the
    // customer each collecting by a different one.)
    let placed = must_get_action(opened.order.clone())?.hashed.content.header.timestamp;
    if at < placed {
        return invalid("an issue window opens after its order was placed");
    }
    let Some(prev) = prev_action else { return invalid("a window can't open a chain") };
    let again = already_wrote::<IssueWindowOpened>(author, prev, placed, UnitEntryTypes::IssueWindowOpened, |o| o.order == opened.order)?;
    require(!again, "an order's issue window opens once")
}

pub(crate) fn validate_window_closed(closed: &IssueWindowClosed, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let opened_record = must_get_valid_record(closed.opened.clone())?;
    let Some(opened) = decode::<IssueWindowOpened>(&opened_record) else { return invalid("a close cites the window's opening") };
    if opened_record.action().author() != author {
        return invalid("the arbitrator who opened a window closes it");
    }
    let opened_at = opened_record.action().timestamp();
    if at.as_micros() < opened_at.as_micros() + relay_governance::issue_window().as_micros() as i64 {
        return invalid("an issue window closes no sooner than the window after it opened");
    }
    let Some(terms) = order_for_issues(&opened.order)? else { return invalid("the window's order is gone") };
    let mut claimed: Vec<(ActionHash, u32)> = Vec::new();
    for (i, issue_ref) in closed.issues.iter().enumerate() {
        if closed.issues[..i].contains(issue_ref) {
            return invalid("a close cites each issue once");
        }
        let issue_record = must_get_valid_record(issue_ref.clone())?;
        let Some(issue) = decode::<ItemIssue>(&issue_record) else { return invalid("a close cites issues") };
        if issue.order != opened.order {
            return invalid("a close cites only its own order's issues");
        }
        if issue_record.action().timestamp() > at {
            return invalid("a close cites only issues reported before it");
        }
        claimed.extend(issue.lines.iter().map(|l| (l.item_ref.clone(), l.quantity)));
    }
    if closed.refund > claimed_value(&terms.lines, terms.order_total, &claimed) {
        return invalid("a refund can't exceed what the cited issues are worth");
    }
    let Some(prev) = prev_action else { return invalid("a close can't open a chain") };
    let again = already_wrote::<IssueWindowClosed>(author, prev, opened_at, UnitEntryTypes::IssueWindowClosed, |c| c.opened == closed.opened)?;
    require(!again, "an issue window closes once")
}
