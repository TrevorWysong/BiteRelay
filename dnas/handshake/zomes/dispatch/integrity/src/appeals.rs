//! Validation for appeals of a store's decision (`dispatch_types::Appeal`):
//!
//! - only an order's customer appeals, once, within the network's window
//!   after their store settled it, to one of the network's arbiters, for no
//!   more than the store kept;
//! - only the order's store answers, once;
//! - only the appeal's arbiter rules, once, awarding no more than was asked.

use super::*;
use crate::issues::{order_for_issues, OrderForIssues};
use dispatch_types::{Appeal, AppealAnswer, ItemSettlement, Ruling};
use handshake_integrity_support::chain::wrote_since;
use handshake_integrity_support::{decode, invalid, require, sealed_chunks_problem, text_problem};
use handshake_integrity_support::limits::MAX_NOTE_CHARS;

/// An appeal's order and the settlement it appeals.
fn appealed(appeal: &Appeal) -> ExternResult<Option<(OrderForIssues, ItemSettlement, Timestamp)>> {
    let Some(terms) = order_for_issues(&appeal.order)? else { return Ok(None) };
    let record = must_get_valid_record(appeal.settlement.clone())?;
    let Some(settlement) = decode::<ItemSettlement>(&record) else { return Ok(None) };
    if settlement.order != appeal.order || record.action().author() != &terms.merchant {
        return Ok(None);
    }
    Ok(Some((terms, settlement, record.action().timestamp())))
}

fn appeal_at(appeal: &ActionHash) -> ExternResult<Option<(Appeal, Timestamp)>> {
    let record = must_get_valid_record(appeal.clone())?;
    Ok(decode::<Appeal>(&record).map(|a| (a, record.action().timestamp())))
}

pub(crate) fn validate_appeal(appeal: &Appeal, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some((terms, settlement, settled_at)) = appealed(appeal)? else { return invalid("an appeal cites its order and its store's settlement of it") };
    if author != &terms.requester {
        return invalid("only an order's customer appeals it");
    }
    if !handshake_governance::is_arbiter(&appeal.arbiter) || appeal.arbiter == terms.requester || appeal.arbiter == terms.merchant {
        return invalid("an appeal goes to one of the network's arbiters, neither party to it");
    }
    if appeal.amount == 0 || appeal.amount > terms.order_total.saturating_sub(settlement.refund) {
        return invalid("an appeal asks for no more than the store kept");
    }
    let closes = (settled_at + handshake_governance::appeal_window()).map_err(|e| wasm_error!(WasmErrorInner::Guest(e.to_string())))?;
    if at < settled_at || at > closes {
        return invalid("an appeal comes within the network's window after the store settles");
    }
    if sealed_chunks_problem("an appeal's evidence", &appeal.sealed_for_arbiter, handshake_integrity_support::max_sealed_image_bytes()).is_some() {
        return invalid("an appeal's evidence is too large");
    }
    let Some(prev) = prev_action else { return invalid("an appeal can't open a chain") };
    let again = wrote_since::<Appeal>(author, prev, settled_at, UnitEntryTypes::Appeal.try_into()?, |a| a.order == appeal.order)?;
    require(!again, "an order is appealed once")
}

pub(crate) fn validate_appeal_answer(answer: &AppealAnswer, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some((appeal, filed_at)) = appeal_at(&answer.appeal)? else { return invalid("an answer cites an appeal") };
    let Some(terms) = order_for_issues(&appeal.order)? else { return invalid("an answer cites an appeal") };
    if author != &terms.merchant {
        return invalid("only the order's store answers an appeal");
    }
    if sealed_chunks_problem("an answer's evidence", &answer.sealed_for_arbiter, handshake_integrity_support::max_sealed_image_bytes()).is_some() {
        return invalid("an answer's evidence is too large");
    }
    let Some(prev) = prev_action else { return invalid("an answer can't open a chain") };
    let again = wrote_since::<AppealAnswer>(author, prev, filed_at, UnitEntryTypes::AppealAnswer.try_into()?, |a| a.appeal == answer.appeal)?;
    require(!again, "a store answers an appeal once")
}

pub(crate) fn validate_ruling(ruling: &Ruling, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some((appeal, filed_at)) = appeal_at(&ruling.appeal)? else { return invalid("a ruling cites an appeal") };
    if author != &appeal.arbiter {
        return invalid("only an appeal's arbiter rules on it");
    }
    if ruling.award > appeal.amount {
        return invalid("a ruling awards no more than was asked");
    }
    if let Some(problem) = text_problem("reasons", &ruling.reasons, MAX_NOTE_CHARS) {
        return invalid(&problem);
    }
    let Some(prev) = prev_action else { return invalid("a ruling can't open a chain") };
    let again = wrote_since::<Ruling>(author, prev, filed_at, UnitEntryTypes::Ruling.try_into()?, |r| r.appeal == ruling.appeal)?;
    require(!again, "an appeal is ruled on once")
}

/// An appeal is found under its order and by its arbiter; its answer and
/// ruling under it; a ruling also under the store's owner, whose cash-outs
/// pay it. Each linked by whoever wrote what it links.
pub(crate) fn validate_appeal_link(link: &OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    let Some(record) = handshake_integrity_support::linked_record(link.target)? else { return invalid("target is not a record") };
    if record.action().author() != link.author {
        return invalid("an appeal's records are linked by whoever wrote them");
    }
    let expected: Vec<AnyLinkableHash> = match link.link_type {
        LinkTypes::OrderToAppeal => decode::<Appeal>(&record).map(|a| vec![a.order.into()]).unwrap_or_default(),
        LinkTypes::ArbiterToAppeal => decode::<Appeal>(&record).map(|a| vec![a.arbiter.into()]).unwrap_or_default(),
        LinkTypes::StoreOwnerToAppeal => match decode::<Appeal>(&record) {
            Some(appeal) => order_for_issues(&appeal.order)?.map(|t| vec![t.merchant.into()]).unwrap_or_default(),
            None => Vec::new(),
        },
        LinkTypes::AppealToAnswer => decode::<AppealAnswer>(&record).map(|a| vec![a.appeal.into()]).unwrap_or_default(),
        LinkTypes::AppealToRuling => decode::<Ruling>(&record).map(|r| vec![r.appeal.into()]).unwrap_or_default(),
        LinkTypes::StoreOwnerToRuling => match decode::<Ruling>(&record) {
            Some(ruling) => match appeal_at(&ruling.appeal)?.map(|(a, _)| order_for_issues(&a.order)).transpose()?.flatten() {
                Some(terms) => vec![terms.merchant.into()],
                None => Vec::new(),
            },
            None => Vec::new(),
        },
        _ => Vec::new(),
    };
    require(expected.contains(link.base), "an appeal's records are linked where they belong")
}
