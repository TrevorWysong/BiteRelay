//! Integrity zome for the stub mutual-credit ledger -- see
//! `LedgerTransaction`'s doc comment for the mutual-credit design and its
//! deliberate simplifications.

use dispatch_types::DeliveryOrder;
use hdi::prelude::*;

/// A stub mutual-credit ledger, internal to `relay`, standing in for
/// HoloFuel until it's live (see architecture plan §4). Every transaction
/// has a `from` and `to`, so summing all transactions across the whole
/// system always nets to zero -- the same property HoloFuel itself is built
/// on -- rather than modeling a fixed-escrow-contract balance. Swapping the
/// real HoloFuel hApp in later means changing only this zome's coordinator
/// internals, not the `Bid`/`LedgerCommitmentRef` shape other zomes depend on.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum TxnReason {
    Payment,
    CollateralForfeit,
}

#[hdk_entry_helper]
#[derive(Clone)]
pub struct LedgerTransaction {
    pub from: AgentPubKey,
    pub to: AgentPubKey,
    pub amount: u64,
    pub reason: TxnReason,
    pub related_order: ActionHash,
    pub created_at: Timestamp,
}

/// A periodic, append-only "balance as of `related_txn`" breadcrumb --
/// architecture plan §9.4. `get_balance` finds the most recent one instead
/// of rescanning an agent's *entire* transaction history on every read.
/// Deliberately append-only (never `update_entry`'d): a single *mutable*
/// shared balance entry would give true O(1) reads, but reintroduces
/// exactly the concurrent-write race the *original* reputation design was
/// already built to avoid (two settlements affecting the same agent
/// near-simultaneously targeting the same prior action forks silently).
/// Written *roughly* every `CHECKPOINT_INTERVAL` transactions per agent (a
/// deterministic, counting-free trigger in the coordinator, not exact) --
/// this makes reads **O(n/K), not O(1)**: the checkpoint set itself still
/// grows without bound over a long enough lifetime, just K times slower.
/// Name that honestly, don't oversell it -- same posture as this crate's
/// existing single-party-trust doc comment below.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct BalanceCheckpoint {
    pub agent: AgentPubKey,
    pub balance: i64,
    pub related_txn: ActionHash,
    pub recorded_at: Timestamp,
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
            EntryTypes::BalanceCheckpoint(checkpoint) => validate_checkpoint(&checkpoint, action.author()),
        },
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

/// Shared authorization check for both `LedgerTransaction` and
/// `BalanceCheckpoint`: trusted if the author is one of the two named
/// parties, a listed arbitrator, or -- the real gap `validate_transaction`'s
/// own doc comment documents in full -- the related order's own requester
/// or merchant (needed because `complete_delivery` settles payment from a
/// single calling conductor, but `settle_delivery_fee` can author a
/// transaction between two *other* parties when customer/merchant/driver
/// are genuinely distinct agents).
fn is_authorized_party_or_order_principal(
    author: &AgentPubKey,
    party_a: &AgentPubKey,
    party_b: &AgentPubKey,
    related_order: &ActionHash,
) -> ExternResult<bool> {
    if author == party_a || author == party_b || relay_governance::is_arbitrator(author)? {
        return Ok(true);
    }
    let order_record = must_get_valid_record(related_order.clone())?;
    let Some(order): Option<DeliveryOrder> = order_record.entry().to_app_option().map_err(|e| wasm_error!(e))? else {
        return Ok(false);
    };
    Ok(author == &order.requester || author == &order.merchant)
}

/// A checkpoint can't be fabricated independent of a real, already-validated
/// transaction: it must reference one via `related_txn`, name one of that
/// transaction's own two parties as the agent it's a balance for, and be
/// authored by whoever `validate_transaction` already trusts to author that
/// specific transaction (reusing the exact same rule, not a looser one).
fn validate_checkpoint(checkpoint: &BalanceCheckpoint, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let txn_record = must_get_valid_record(checkpoint.related_txn.clone())?;
    let Some(txn): Option<LedgerTransaction> = txn_record.entry().to_app_option().map_err(|e| wasm_error!(e))? else {
        return Ok(ValidateCallbackResult::Invalid("related_txn does not point at a LedgerTransaction entry".into()));
    };
    if checkpoint.agent != txn.from && checkpoint.agent != txn.to {
        return Ok(ValidateCallbackResult::Invalid(
            "checkpoint agent must be one of related_txn's two parties".into(),
        ));
    }
    if !is_authorized_party_or_order_principal(author, &txn.from, &txn.to, &txn.related_order)? {
        return Ok(ValidateCallbackResult::Invalid(
            "a checkpoint can only be authored by one of its related transaction's two parties, a listed arbitrator, or the related order's own requester/merchant".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_transaction(txn: &LedgerTransaction, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if txn.from == txn.to {
        return Ok(ValidateCallbackResult::Invalid("a transaction's from and to must be different agents".into()));
    }
    if txn.amount == 0 {
        return Ok(ValidateCallbackResult::Invalid("amount must be greater than zero".into()));
    }
    // A real ledger needs both parties' agreement (the same countersigning
    // treatment `attestation` uses for receipts) before a transaction is
    // trustworthy. This stub allows single-party recording, validated only
    // against the referenced order actually existing -- a known, named gap,
    // not a hardened settlement path.
    //
    // Beyond the transaction's own two sides and a listed arbitrator (a
    // dispute ruling, architecture plan §8), the related order's own
    // requester or merchant are also trusted authors -- see
    // `is_authorized_party_or_order_principal`'s own doc comment for why:
    // a real bug, found only by testing with three *genuinely distinct*
    // customer/merchant/driver agents rather than the "customer doubles as
    // merchant" convention most of this codebase's other tests happened to
    // use. `dispatch::settle_delivery_fee` splits the delivery fee into up
    // to two transactions (merchant -> driver for the subsidy share,
    // customer -> driver for the rest + tip), but `complete_delivery` is
    // called from exactly *one* conductor -- that caller can never be the
    // `from` party on *both* transactions when all three are distinct
    // agents and the subsidy is nonzero (the *default*, not a rare case).
    // Exactly one of the two transactions would always fail this check
    // before this exception existed.
    if !is_authorized_party_or_order_principal(author, &txn.from, &txn.to, &txn.related_order)? {
        return Ok(ValidateCallbackResult::Invalid(
            "a transaction can only be authored by one of its two parties, a listed arbitrator, or the related order's own requester/merchant".into(),
        ));
    }
    must_get_valid_record(txn.related_order.clone())?;
    Ok(ValidateCallbackResult::Valid)
}
