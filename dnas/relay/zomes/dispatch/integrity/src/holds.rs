//! The money behind each step of an order: an order moves on only once
//! whoever owes for that step has set it aside (see
//! `dispatch_types::settlement`), and the step's update cites the hold.
//! The ledger validates the hold itself -- its amount, its payer, the
//! balance behind it; this checks that the step cites the right one.

use super::*;
use dispatch_types::{hold_terms, HoldPurpose, OrderTerms};
use ledger_types::{LedgerEntry, LedgerKind};
use relay_integrity_support::decode;

/// One step's hold: what it must be for, and who must have paid it.
pub(crate) struct ExpectedHold<'a> {
    pub order_original: &'a ActionHash,
    pub terms: &'a OrderTerms,
    pub purpose: HoldPurpose,
    pub bid: Option<&'a Bid>,
}

/// A step that needs a hold must cite exactly that hold; a step for which
/// nothing is owed (a customer ordering from their own store, a fee the
/// store covers in full) must cite none.
pub(crate) fn check_hold(cited: &Option<ActionHash>, expected: ExpectedHold<'_>) -> ExternResult<Result<(), String>> {
    let Some((payer, shares)) = hold_terms(expected.terms, &expected.purpose, expected.bid) else {
        return Ok(Err("that hold doesn't fit this order".into()));
    };
    let Some(hold_ref) = cited else {
        return Ok(if shares.is_empty() { Ok(()) } else { Err(format!("this step needs its {:?} hold, set aside first", expected.purpose)) });
    };
    if shares.is_empty() {
        return Ok(Err("nothing is owed for this step, so it cites no hold".into()));
    }
    let record = must_get_valid_record(hold_ref.clone())?;
    let Some(LedgerEntry { kind: LedgerKind::Hold { order, purpose }, .. }) = decode::<LedgerEntry>(&record) else {
        return Ok(Err("a step's hold must be a ledger hold".into()));
    };
    let matches = &order == expected.order_original && purpose == expected.purpose && record.action().author() == &payer;
    Ok(if matches { Ok(()) } else { Err("a step must cite its own order's hold, for this step, paid by whoever owes it".into()) })
}

/// The order's terms, from its as-created record.
pub(crate) fn terms_of(order_original: &ActionHash) -> ExternResult<Option<OrderTerms>> {
    let record = must_get_valid_record(order_original.clone())?;
    if let Some(order) = decode::<DeliveryOrder>(&record) {
        return Ok(Some(OrderTerms::of_delivery(&order)));
    }
    Ok(decode::<PickupOrder>(&record).map(|order| OrderTerms::of_pickup(&order)))
}
