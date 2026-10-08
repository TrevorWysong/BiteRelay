//! Integrity zome for the stub mutual-credit ledger. Every transaction has
//! a `from` and a `to`, so all balances net to zero across the system -- the
//! property HoloFuel is built on -- standing in for it until it's live.
//!
//! What validation guarantees:
//! - a payment is one leg of settling a completed order, for exactly the
//!   amount that leg owes (`dispatch_types::settlement`), authored by the
//!   agent paying it -- nobody can write a payment *to* themselves, or
//!   between two other people;
//! - collateral moves only by an arbitrator's ruling, for exactly the
//!   amount ruled, from the losing side to the winning one;
//! - a balance checkpoint is only ever written by the agent it's for.
//!
//! What it can't: stop a payer from paying twice (that only costs them),
//! or prove a payer *did* pay -- an unpaid leg is visible as missing, and
//! is a dispute.

use dispatch_types::{delivery_payments, pickup_payments, Bid, DeliveryOrder, DeliveryStatus, LegPayment, PickupOrder, PickupStatus};
pub use dispatch_types::PaymentLeg;
use dispute_types::{Dispute, DisputeOutcome, DisputeStatus};
use hdi::prelude::*;
use relay_integrity_support::{decode, invalid, link_target, original_creation, require, valid, LinkTarget};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum TxnReason {
    /// One leg of settling a completed order.
    Payment(PaymentLeg),
    /// Collateral moved by an arbitrator's dispute ruling.
    CollateralForfeit,
}

#[hdk_entry_helper]
#[derive(Clone)]
pub struct LedgerTransaction {
    pub from: AgentPubKey,
    pub to: AgentPubKey,
    pub amount: u64,
    pub reason: TxnReason,
    /// The order this settles (its original action).
    pub related_order: ActionHash,
    /// The record that justifies it: for a payment, the version of the
    /// order that completed it (`Delivered`/`PickedUp`); for a forfeit, the
    /// resolved `Dispute`.
    pub basis: ActionHash,
    pub created_at: Timestamp,
}

/// An agent's own running balance, so a read sums only the transactions
/// since the last checkpoint rather than their whole history. Written only
/// by the agent it's for (`ledger::get_balance`), and only over
/// transactions old enough that gossip has delivered everything up to that
/// point (the settling window) -- so a late-arriving payment can't land
/// behind it.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct BalanceCheckpoint {
    pub agent: AgentPubKey,
    pub balance: i64,
    /// Every transaction linked to `agent` up to and including this
    /// timestamp is counted in `balance`.
    pub covers_until: Timestamp,
    /// The counted transactions linked at exactly `covers_until`. Link
    /// queries' time filter is inclusive, so the next read skips these
    /// instead of counting them twice.
    pub boundary: Vec<ActionHash>,
}

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    LedgerTransaction(LedgerTransaction),
    BalanceCheckpoint(BalanceCheckpoint),
}

#[hdk_link_types]
pub enum LinkTypes {
    AgentToTransaction,
    AgentToBalanceCheckpoint,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::LedgerTransaction(txn) => validate_transaction(&txn, action.author()),
            EntryTypes::BalanceCheckpoint(checkpoint) => require(&checkpoint.agent == action.author(), "a balance checkpoint can only be written by the agent it's for"),
        },
        FlatOp::CreateEntry(OpEntry::UpdateEntry { .. }) | FlatOp::Update(_) => invalid("ledger entries can't be updated"),
        FlatOp::Delete(_) => invalid("ledger entries can't be deleted"),
        FlatOp::Link(OpLink::CreateLink { link_type, action }) => validate_create_link(link_type, &action.base_address, &action.target_address, action.author()),
        FlatOp::Link(OpLink::DeleteLink { .. }) => invalid("ledger links can't be deleted"),
        _ => valid(),
    }
}

/// Balances are folded from these links, so each must sit under an agent
/// the entry actually concerns, linked by the entry's own author.
fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let LinkTarget::Record(record) = link_target(target)? else {
        return invalid("ledger links must target a record");
    };
    if author != record.action().author() {
        return invalid("a ledger link must be authored by the author of the entry it indexes");
    }
    match link_type {
        LinkTypes::AgentToTransaction => {
            let Some(txn) = decode::<LedgerTransaction>(&record) else { return invalid("target is not a LedgerTransaction") };
            require(
                base == &AnyLinkableHash::from(txn.from) || base == &AnyLinkableHash::from(txn.to),
                "a transaction may only be linked under one of its own two parties",
            )
        }
        LinkTypes::AgentToBalanceCheckpoint => {
            let Some(checkpoint) = decode::<BalanceCheckpoint>(&record) else { return invalid("target is not a BalanceCheckpoint") };
            require(base == &AnyLinkableHash::from(checkpoint.agent), "a balance checkpoint may only be linked under its own agent")
        }
    }
}

fn validate_transaction(txn: &LedgerTransaction, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if txn.from == txn.to {
        return invalid("a transaction's from and to must be different agents");
    }
    if txn.amount == 0 {
        return invalid("amount must be greater than zero");
    }
    match &txn.reason {
        TxnReason::Payment(leg) => validate_payment(txn, *leg, author),
        TxnReason::CollateralForfeit => validate_forfeit(txn, author),
    }
}

/// A payment must be exactly one leg the completed order owes -- right
/// payer, payee and amount -- paid by the payer themselves. An arbitrator
/// may also settle an order their ruling completed.
fn validate_payment(txn: &LedgerTransaction, leg: PaymentLeg, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if original_creation(txn.basis.clone())? != txn.related_order {
        return invalid("a payment's basis must be a version of the order it settles");
    }
    let basis = must_get_valid_record(txn.basis.clone())?;
    let owed: Vec<LegPayment> = if let Some(order) = decode::<DeliveryOrder>(&basis) {
        if order.status != DeliveryStatus::Delivered {
            return invalid("a delivery is only paid for once it's Delivered");
        }
        let Some(bid_ref) = &order.accepted_bid else { return invalid("a delivered order must have an accepted bid") };
        let Some(bid) = decode::<Bid>(&must_get_valid_record(bid_ref.clone())?) else { return invalid("accepted_bid is not a Bid") };
        delivery_payments(&order, &bid)
    } else if let Some(order) = decode::<PickupOrder>(&basis) {
        if order.status != PickupStatus::PickedUp {
            return invalid("a pickup order is only paid for once it's PickedUp");
        }
        pickup_payments(&order)
    } else {
        return invalid("a payment's basis must be a DeliveryOrder or PickupOrder");
    };
    let Some(expected) = owed.iter().find(|p| p.leg == leg) else {
        return invalid("this order owes nothing for that payment leg");
    };
    if expected.from != txn.from || expected.to != txn.to || expected.amount != txn.amount {
        return invalid("a payment must match what its leg owes: payer, payee and amount");
    }
    require(
        author == &txn.from || relay_governance::is_arbitrator(author)?,
        "a payment can only be authored by the agent paying it (or an arbitrator settling a ruling)",
    )
}

/// Collateral moves only by an arbitrator's ruling: the amount it named,
/// from the losing side to the winning one. The provider (driver or store)
/// is whichever party to the dispute isn't the order's requester.
fn validate_forfeit(txn: &LedgerTransaction, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if !relay_governance::is_arbitrator(author)? {
        return invalid("collateral can only be moved by an arbitrator");
    }
    let Some(dispute) = decode::<Dispute>(&must_get_valid_record(txn.basis.clone())?) else {
        return invalid("a forfeit's basis must be a Dispute");
    };
    let (DisputeStatus::Resolved, Some(outcome)) = (&dispute.status, &dispute.outcome) else {
        return invalid("a forfeit's basis must be a resolved dispute");
    };
    if dispute.order_ref != txn.related_order {
        return invalid("a forfeit must settle the disputed order");
    }
    let order = must_get_valid_record(txn.related_order.clone())?;
    let requester = if let Some(o) = decode::<DeliveryOrder>(&order) {
        o.requester
    } else if let Some(o) = decode::<PickupOrder>(&order) {
        o.requester
    } else {
        return invalid("related_order is not an order");
    };
    let provider = if dispute.raised_by == requester { dispute.respondent.clone() } else { dispute.raised_by.clone() };
    let (from, to, amount) = match outcome {
        DisputeOutcome::FavorProvider { forfeit_amount } => (&requester, &provider, *forfeit_amount),
        DisputeOutcome::FavorRequester { forfeit_amount } => (&provider, &requester, *forfeit_amount),
    };
    require(
        &txn.from == from && &txn.to == to && txn.amount == amount,
        "a forfeit must move exactly the ruled amount, from the losing side to the winning one",
    )
}
