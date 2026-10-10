//! The ledger's entries, factored out of `ledger_integrity` so other zomes'
//! validation (an order citing its holds) can decode them without linking in
//! `ledger_integrity`'s own wasm exports -- same reasoning as
//! `dispatch_types`.
//!
//! Every change to an agent's balance is an entry on *their own* chain,
//! carrying the balance it leaves them with and pointing at their previous
//! entry. Validation walks their chain to check none is skipped and the
//! arithmetic holds, so a balance is never anyone's say-so: it's the last
//! entry on the agent's chain, and a fork of that chain is the kind of
//! misbehaviour Holochain itself catches.

pub use dispatch_types::{CarryRefusal, HoldPurpose, InHand, Portion};
use hdi::prelude::*;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum LedgerKind {
    /// Funds issued to the author by an issuer (`IssuerGrant`). Credit.
    Deposit { grant: ActionHash },
    /// The author setting money aside for an order (its original action).
    /// Debit. See `dispatch_types::settlement`.
    Hold { order: ActionHash, purpose: HoldPurpose },
    /// The author taking a part of a hold they're owed -- or, as its payer,
    /// a part returned to them -- with `basis`, the record that entitles
    /// them. Credit.
    Collect { hold: ActionHash, portion: Portion, basis: ActionHash },
    /// The author, a part's recipient, giving it back to the hold's payer
    /// (an order cancelled before they were owed it). No change to the
    /// author's balance; the payer collects it.
    Waive { hold: ActionHash, portion: Portion },
    /// The author, a driver, conceding their collateral to the store on its
    /// decision that the order never arrived (`basis`) -- the store collects
    /// it. No change to the author's balance; it settles the order they had
    /// in hand (`InHand`).
    Forfeit { hold: ActionHash, basis: ActionHash },
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct LedgerEntry {
    pub kind: LedgerKind,
    pub amount: u64,
    /// The author's balance after this entry.
    pub balance: i64,
    /// The orders the author has in hand after this entry.
    pub in_hand: InHand,
    /// The author's previous ledger entry -- `None` only for their first.
    pub previous: Option<ActionHash>,
}

/// Funds issued to an agent by an issuer on the DNA's roster
/// (`relay_governance::is_issuer`) -- the stand-in for a payment processor
/// crediting an account against a real payment. The agent collects it into
/// their balance with a `Deposit`.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct IssuerGrant {
    pub to: AgentPubKey,
    pub amount: u64,
    /// The issuer's own reference (a payment id), so a grant is unique.
    pub reference: String,
}
