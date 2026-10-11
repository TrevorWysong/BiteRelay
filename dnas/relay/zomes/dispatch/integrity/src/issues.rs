//! Validation for how an order settles -- see `dispatch_types::issues` for
//! the flow. What it guarantees:
//!
//! - only an order's own customer reports issues with it, only for items on
//!   it, never more units than were ordered; only its store answers each,
//!   once;
//! - only the order's store decides its outcome and its settlement, once
//!   each -- so every payment cites the same decision, and none can
//!   contradict another;
//! - *Delivered* only on the order completed with proof; *not delivered*
//!   only on the customer's claim, made after the driver's proven pickup,
//!   and never by a store that cancelled the order;
//! - a settlement's refund is never more than the issues it cites are worth
//!   of what the customer paid -- plus, for a delivery its customer
//!   collected themselves, the store's share of the fee it would have paid a
//!   driver, which it must refund (`collection_compensation`).

use super::*;
use crate::claims::wrote_update_of;
use dispatch_types::{claimed_value, IssueResponse, ItemIssue, ItemSettlement, OrderOutcome, Outcome};
use relay_integrity_support::chain::wrote_since;
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

/// A customer's report of items missing or wrong: theirs, once they have
/// the order, about items on it -- each item reported once, so an order's
/// reports are bounded by its lines and no item is claimed twice.
pub(crate) fn validate_item_issue(issue: &ItemIssue, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(terms) = order_for_issues(&issue.order)? else {
        return invalid("an issue is reported about an order, by its original action");
    };
    if author != &terms.requester {
        return invalid("only the order's customer reports issues with it");
    }
    let received = if terms.delivery {
        version_of::<DeliveryOrder>(&issue.order, &issue.received)?.is_some_and(|(_, v)| matches!(v.status, DeliveryStatus::Delivered | DeliveryStatus::Collected))
    } else {
        version_of::<PickupOrder>(&issue.order, &issue.received)?.is_some_and(|(record, v)| v.status == PickupStatus::PickedUp && record.action().author() == author)
    };
    if !received {
        return invalid("an issue is reported once the customer has the order, citing the version that shows it");
    }
    let Some(prev) = prev_action else { return invalid("an issue can't open a chain") };
    let placed = must_get_action(issue.order.clone())?.hashed.content.header.timestamp;
    let reported_again = |earlier: &ItemIssue| earlier.order == issue.order && earlier.lines.iter().any(|old| issue.lines.iter().any(|new| new.item_ref == old.item_ref));
    if wrote_since::<ItemIssue>(author, prev, placed, UnitEntryTypes::ItemIssue.try_into()?, reported_again)? {
        return invalid("each item on an order is reported once");
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
    let bounded = relay_integrity_support::sealed_chunks_problem("an issue's evidence", &issue.sealed_for_store, relay_integrity_support::max_sealed_image_bytes()).is_none();
    require(bounded, "an issue's evidence may hold a note and at most one photo, within the network's image limit")
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
    let answered = wrote_since::<IssueResponse>(author, prev, issue_record.action().timestamp(), UnitEntryTypes::IssueResponse.try_into()?, |r| r.issue == response.issue)?;
    require(!answered, "a store answers each issue once")
}

/// When `order` was placed: every decision about it is dated after, so a
/// walk of the store's chain back to it sees all of them.
fn placed_at(order: &ActionHash) -> ExternResult<Timestamp> {
    Ok(must_get_action(order.clone())?.hashed.content.header.timestamp)
}

/// A version of `order`, decoded -- `None` if it isn't one.
fn version_of<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(order: &ActionHash, version: &ActionHash) -> ExternResult<Option<(Record, T)>> {
    if &original_creation(version.clone())? != order {
        return Ok(None);
    }
    let record = must_get_valid_record(version.clone())?;
    Ok(decode::<T>(&record).map(|v| (record, v)))
}

pub(crate) fn validate_outcome(outcome: &OrderOutcome, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(terms) = order_for_issues(&outcome.order)? else { return invalid("an outcome is decided for an order, by its original action") };
    if !terms.delivery {
        return invalid("only a delivery has an outcome to decide");
    }
    if author != &terms.merchant {
        return invalid("only the order's store decides its outcome");
    }
    let placed = placed_at(&outcome.order)?;
    if at < placed {
        return invalid("an outcome is decided after its order was placed");
    }
    let Some(prev) = prev_action else { return invalid("an outcome can't open a chain") };
    let decided = wrote_since::<OrderOutcome>(author, prev, placed, UnitEntryTypes::OrderOutcome.try_into()?, |o| o.order == outcome.order)?;
    if decided {
        return invalid("an order's outcome is decided once");
    }
    match &outcome.outcome {
        Outcome::Delivered { proof } => {
            let delivered = version_of::<DeliveryOrder>(&outcome.order, proof)?.is_some_and(|(_, v)| v.status == DeliveryStatus::Delivered);
            require(delivered, "a delivered outcome cites the order completed on proof the customer has it")
        }
        Outcome::NotDelivered { claim } => {
            let Some((record, version)) = version_of::<DeliveryOrder>(&outcome.order, claim)? else { return invalid("a claim is a version of its order") };
            // The only way into Disputed is the customer's claim from
            // PickedUp, which the driver reached on proof of the pickup.
            if version.status != DeliveryStatus::Disputed || record.action().author() != &terms.requester {
                return invalid("not delivered cites the customer's claim that it never arrived");
            }
            // A store that cancelled the order (refunding the customer) can't
            // also take the driver's collateral for it.
            let cancelled = wrote_update_of(author, prev, &outcome.order, |v| v.status == DeliveryStatus::Cancelled)?;
            require(!cancelled, "a store that cancelled an order can't decide it went undelivered")
        }
    }
}

pub(crate) fn validate_settlement(settlement: &ItemSettlement, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(terms) = order_for_issues(&settlement.order)? else { return invalid("a settlement is for an order, by its original action") };
    if author != &terms.merchant {
        return invalid("only the order's store settles it");
    }
    let placed = placed_at(&settlement.order)?;
    if at < placed {
        return invalid("a settlement comes after its order was placed");
    }
    // That the customer has the order -- and, collected from the store,
    // what the store owes them for coming.
    let (has_it, owed) = if terms.delivery {
        let record = must_get_valid_record(settlement.basis.clone())?;
        let delivered = decode::<OrderOutcome>(&record).is_some_and(|o| o.order == settlement.order && matches!(o.outcome, Outcome::Delivered { .. }));
        match version_of::<DeliveryOrder>(&settlement.order, &settlement.basis)? {
            Some((record, version)) if !delivered && version.status == DeliveryStatus::Collected => (true, dispatch_types::lineage::collection_owed(&dispatch_types::lineage::Version { record, order: version })?),
            _ => (delivered, 0),
        }
    } else {
        (version_of::<PickupOrder>(&settlement.order, &settlement.basis)?.is_some_and(|(record, v)| v.status == PickupStatus::PickedUp && record.action().author() == &terms.requester), 0)
    };
    if !has_it {
        return invalid("a settlement cites that the customer has the order: its delivered outcome, or its collection");
    }
    if settlement.refund < owed {
        return invalid("a delivery its customer collected refunds them the store's share of the fee it would have paid a driver");
    }
    let mut claimed: Vec<(ActionHash, u32)> = Vec::new();
    for (i, issue_ref) in settlement.issues.iter().enumerate() {
        if settlement.issues[..i].contains(issue_ref) {
            return invalid("a settlement cites each issue once");
        }
        let issue_record = must_get_valid_record(issue_ref.clone())?;
        let Some(issue) = decode::<ItemIssue>(&issue_record) else { return invalid("a settlement cites issues") };
        if issue.order != settlement.order {
            return invalid("a settlement cites only its own order's issues");
        }
        if issue_record.action().timestamp() > at {
            return invalid("a settlement cites only issues reported before it");
        }
        claimed.extend(issue.lines.iter().map(|l| (l.item_ref.clone(), l.quantity)));
    }
    if settlement.refund > claimed_value(&terms.lines, terms.order_total, &claimed).saturating_add(owed).min(terms.order_total) {
        return invalid("a refund can't exceed what the cited issues are worth");
    }
    let Some(prev) = prev_action else { return invalid("a settlement can't open a chain") };
    let again = wrote_since::<ItemSettlement>(author, prev, placed, UnitEntryTypes::ItemSettlement.try_into()?, |s| s.order == settlement.order)?;
    require(!again, "an order is settled once")
}
