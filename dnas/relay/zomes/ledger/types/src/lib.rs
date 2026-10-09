//! `LedgerTransaction`, factored out of `ledger_integrity` so
//! `dispatch_integrity` can decode one (a driver's collateral hold, before
//! allowing a pickup) without linking in `ledger_integrity`'s own wasm
//! exports -- same reasoning as `dispatch_types`/`dispute_types`.

pub use dispatch_types::PaymentLeg;
use hdi::prelude::*;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum TxnReason {
    /// One leg of settling a completed order.
    Payment(PaymentLeg),
    /// A driver's collateral, posted to the customer when they pick up the
    /// customer's food -- each holds the other's value until delivery, when
    /// the customer returns it (`PaymentLeg::CollateralReturn`). If an
    /// arbitrator rules for the customer, they keep it.
    CollateralHold,
    /// Moved by an arbitrator's dispute ruling.
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
    /// order that completed it (`Delivered`/`PickedUp`); for a collateral
    /// hold, the version that assigned the driver; for a forfeit, the
    /// resolved `Dispute`.
    pub basis: ActionHash,
    pub created_at: Timestamp,
}
