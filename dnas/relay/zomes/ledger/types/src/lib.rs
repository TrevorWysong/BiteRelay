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
    /// The author setting aside their store's listing stake, which backs
    /// one listing of `catalog` (its original action) for customers to find.
    /// Debit.
    Stake { catalog: ActionHash },
    /// The author taking their listing stake back, citing `delisting`: their
    /// deletion of the very listing it backed. Credit.
    Unstake { stake: ActionHash, delisting: ActionHash },
    /// The author, a driver, conceding their collateral to the store on its
    /// decision that the order never arrived (`basis`) -- the store collects
    /// it. No change to the author's balance; it settles the order they had
    /// in hand (`InHand`).
    Forfeit { hold: ActionHash, basis: ActionHash },
    /// The author cashing out `amount` through `issuer` (one on the
    /// network's roster), which pays it to them outside the network --
    /// their bank, through its payment processor. Debit, and never into
    /// credit: only money the author has can leave. `instructions`, sealed to
    /// the issuer, says where to pay if the issuer doesn't already know (an
    /// account it gave them, a HoloFuel address).
    Redeem { issuer: AgentPubKey, instructions: Option<XSalsa20Poly1305EncryptedData> },
    /// The author taking back a cash-out its issuer declined (`outcome`, the
    /// issuer's `RedemptionOutcome`). Credit, of what the cash-out took.
    Reclaim { redemption: ActionHash, outcome: ActionHash },
}

#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
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
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct IssuerGrant {
    pub to: AgentPubKey,
    pub amount: u64,
    /// The issuer's own reference (a payment id), so a grant is unique.
    pub reference: String,
}

/// What an issuer did with a cash-out: paid it outside the network, or
/// declined it -- and its funds go back to the redeemer (`LedgerKind::Reclaim`).
/// Written once per cash-out, by the issuer it names.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct RedemptionOutcome {
    /// The redeemer's `Redeem` ledger entry.
    pub redemption: ActionHash,
    pub outcome: PayoutOutcome,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum PayoutOutcome {
    /// Paid out; `reference` is the issuer's payout id (its processor's
    /// transfer), so the redeemer can trace it.
    Paid { reference: String },
    /// Not paid -- no payout account set up, a check failed -- and why.
    Declined { reason: String },
}

/// What an issuer tells the network about itself: who it is, and its terms
/// for cashing out -- what the app shows before anyone asks it to pay out.
/// Its own to change; whether it may issue at all is the network's roster.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct IssuerProfile {
    pub name: String,
    /// How it pays out, and anything to know first ("Bank transfer through
    /// Stripe. Set up your payout account at ...").
    pub description: String,
    /// Where to reach it: an email address or a website.
    pub contact: String,
    /// What it keeps from each cash-out: a flat amount, plus a share in
    /// basis points (1/100 of a percent).
    pub payout_fee_cents: u64,
    pub payout_fee_basis_points: u16,
    /// The least it pays out at once -- never below the network's minimum.
    pub min_payout_cents: u64,
    /// How many days a cash-out usually takes to arrive.
    pub payout_days: u8,
}

impl IssuerProfile {
    /// What a cash-out of `amount` comes to after this issuer's fee --
    /// rounded in the redeemer's favour, and never below nothing.
    pub fn payout_after_fees(&self, amount: u64) -> u64 {
        let share = (u128::from(amount) * u128::from(self.payout_fee_basis_points)) / 10_000;
        amount.saturating_sub(self.payout_fee_cents).saturating_sub(share as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(flat: u64, bps: u16) -> IssuerProfile {
        IssuerProfile { name: "Relay Credits".into(), description: String::new(), contact: String::new(), payout_fee_cents: flat, payout_fee_basis_points: bps, min_payout_cents: 0, payout_days: 2 }
    }

    // The same cases run in web/test/wallet.test.ts -- keep them in step.
    #[test]
    fn a_payout_is_the_amount_less_its_fees() {
        assert_eq!(profile(25, 25).payout_after_fees(10_000), 10_000 - 25 - 25);
        assert_eq!(profile(0, 0).payout_after_fees(1234), 1234);
        assert_eq!(profile(0, 150).payout_after_fees(333), 333 - 4, "the percentage rounds down");
        assert_eq!(profile(500, 0).payout_after_fees(300), 0, "never below nothing");
    }
}
