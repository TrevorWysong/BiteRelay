//! Coordinator zome for the stub mutual-credit ledger (plan §4): no real
//! escrow/locking, just append-only `LedgerTransaction`s recorded at
//! settlement time and a derived balance read. Swapping in real HoloFuel
//! later means changing this crate's internals only -- see the integrity
//! crate's doc comment.

use hdk::prelude::*;
use ledger_integrity::*;
use relay_coordinator_support::{fold_since_checkpoint, latest_checkpoint, next_page_cursor, should_checkpoint};
use relay_types::LedgerCommitmentRef;

/// No entry is created here -- there is nothing to "lock" in a mutual-credit
/// model without a settled transaction (see the integrity crate's doc
/// comment). This just produces the reference embedded in a `Bid`; the real
/// transaction is created later by `release_on_completion` or `forfeit`.
#[derive(Serialize, Deserialize, Debug)]
pub struct LockCollateralInput {
    pub bidder: AgentPubKey,
    pub amount: u64,
}

#[hdk_extern]
pub fn lock_collateral(input: LockCollateralInput) -> ExternResult<LedgerCommitmentRef> {
    Ok(LedgerCommitmentRef {
        account: input.bidder.to_string(),
        amount: input.amount,
        ledger_txn_ref: "pending".into(),
    })
}

/// Roughly every this-many transactions per agent, a `BalanceCheckpoint` is
/// also written -- see architecture plan §9.4 and `BalanceCheckpoint`'s doc
/// comment for why this is O(n/K), not O(1), and why that's an honest,
/// meaningful improvement rather than a complete fix.
const CHECKPOINT_INTERVAL: u64 = 20;

/// Best-effort: a checkpoint is purely a read-side optimization
/// (`get_balance` falls back to summing more transactions if the latest one
/// it finds is older, it never *requires* a checkpoint to exist), so a
/// failure here should never fail the settlement it's piggybacking on.
/// `recorded_at` is deliberately the *transaction's own* `created_at`, not a
/// fresh `sys_time()` call -- keeping them identical is what lets
/// `get_balance`'s `after: recorded_at` filter exclude exactly this
/// transaction (already baked into `balance`) with no clock-ordering
/// assumption needed.
fn maybe_write_checkpoint(agent: AgentPubKey, txn_hash: ActionHash, txn_created_at: Timestamp) {
    if !should_checkpoint(&txn_hash, CHECKPOINT_INTERVAL) {
        return;
    }
    let Ok(balance) = get_balance(agent.clone()) else { return };
    let checkpoint = BalanceCheckpoint { agent: agent.clone(), balance, related_txn: txn_hash, recorded_at: txn_created_at };
    if let Ok(action_hash) = create_entry(&EntryTypes::BalanceCheckpoint(checkpoint)) {
        let _ = create_link(agent, action_hash, LinkTypes::AgentToBalanceCheckpoint, ());
    }
}

fn record_transaction(
    from: AgentPubKey,
    to: AgentPubKey,
    amount: u64,
    reason: TxnReason,
    related_order: ActionHash,
) -> ExternResult<Record> {
    let created_at = sys_time()?;
    let txn = LedgerTransaction { from: from.clone(), to: to.clone(), amount, reason, related_order, created_at };
    let action_hash = create_entry(&EntryTypes::LedgerTransaction(txn))?;
    create_link(from.clone(), action_hash.clone(), LinkTypes::AgentToTransaction, ())?;
    create_link(to.clone(), action_hash.clone(), LinkTypes::AgentToTransaction, ())?;
    // get_balance (inside maybe_write_checkpoint) reads via GetStrategy::Local,
    // so it needs this transaction to already be visible locally -- true here
    // since we just authored it ourselves, on our own chain, in this same call.
    maybe_write_checkpoint(from, action_hash.clone(), created_at);
    maybe_write_checkpoint(to, action_hash.clone(), created_at);
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back ledger transaction".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SettleInput {
    pub order_ref: ActionHash,
    pub from: AgentPubKey,
    pub to: AgentPubKey,
    pub amount: u64,
}

#[hdk_extern]
pub fn release_on_completion(input: SettleInput) -> ExternResult<Record> {
    record_transaction(input.from, input.to, input.amount, TxnReason::Payment, input.order_ref)
}

#[hdk_extern]
pub fn forfeit(input: SettleInput) -> ExternResult<Record> {
    record_transaction(input.from, input.to, input.amount, TxnReason::CollateralForfeit, input.order_ref)
}

/// Net balance for `agent`: positive means net-received, negative means
/// net-paid. Every transaction has a from and a to, so summing this across
/// every agent in the system always nets to zero.
///
/// Uses `GetStrategy::Local`, not the `Network` default -- the attestation
/// zome's isolated spike found that on a small/fresh network, a live
/// network round-trip for `get_links` can come back empty even after
/// gossip has already delivered the data locally, since the querying peer
/// may not yet be a confirmed DHT-basis authority for the hash.
///
/// Finds the most recent `BalanceCheckpoint` (architecture plan §9.4) and
/// sums only the transactions since it, instead of this agent's *entire*
/// transaction history -- O(n/K), not O(1) (the checkpoint set itself still
/// grows, just `CHECKPOINT_INTERVAL` times slower), and a checkpoint is
/// never required to exist: an agent with no checkpoint yet (or none at
/// all) just falls back to summing everything, which is exactly today's
/// behavior and still fully correct, just not fast.
#[hdk_extern]
pub fn get_balance(agent: AgentPubKey) -> ExternResult<i64> {
    let checkpoint = latest_checkpoint(agent.clone(), LinkTypes::AgentToBalanceCheckpoint, |c: &BalanceCheckpoint| c.recorded_at)?;
    let (mut balance, since, already_counted) = match &checkpoint {
        Some(checkpoint) => (checkpoint.balance, Some(checkpoint.recorded_at), Some(checkpoint.related_txn.clone())),
        None => (0_i64, None, None),
    };

    // `LinkQuery.after` is `>=`, not strictly-greater (confirmed against the
    // actual holochain_state 0.6.3 SQL, not assumed) -- since
    // `checkpoint.recorded_at` is deliberately identical to its own
    // `related_txn`'s timestamp (see `maybe_write_checkpoint`), that one
    // transaction would otherwise come back in this query too and get
    // double-counted (once via `checkpoint.balance`, once summed again).
    // Skip it explicitly by hash rather than relying on timestamp precision.
    fold_since_checkpoint::<LedgerTransaction, _, _>(
        agent.clone(),
        LinkTypes::AgentToTransaction,
        since,
        already_counted,
        &mut balance,
        |balance, txn| {
            if txn.to == agent {
                *balance += txn.amount as i64;
            } else if txn.from == agent {
                *balance -= txn.amount as i64;
            }
        },
    )?;
    Ok(balance)
}

/// How many `BalanceCheckpoint`s exist for `agent` -- genuinely useful for
/// debugging/monitoring the checkpoint mechanism itself (architecture plan
/// §9.4: is it actually engaging, roughly how often), not just a test hook.
#[hdk_extern]
pub fn count_balance_checkpoints(agent: AgentPubKey) -> ExternResult<u32> {
    let links = get_links(
        LinkQuery::try_new(agent, LinkTypes::AgentToBalanceCheckpoint)?,
        GetStrategy::Local,
    )?;
    Ok(links.len() as u32)
}

const TRANSACTION_PAGE_SIZE: usize = 50;

#[derive(Serialize, Deserialize, Debug)]
pub struct ListMyTransactionsInput {
    /// Page cursor -- pass back the previous call's `next_after` to continue.
    /// `None` starts from the beginning (oldest first), same convention as
    /// `catalog::list_menu_items`.
    pub after: Option<Timestamp>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TransactionsPage {
    pub transactions: Vec<Record>,
    pub next_after: Option<Timestamp>,
}

/// The "no-skim" transparency dashboard's one real data source: every
/// `LedgerTransaction` this agent is a party to (as either `from` or
/// `to`), full records rather than `get_balance`'s folded sum -- the
/// dashboard shows *where* each cent went, not just the net total.
/// Deliberately **not** checkpoint-accelerated like `get_balance`: a
/// checkpoint only carries a running *sum* forward, which is exactly the
/// information this read throws away on purpose (it wants the individual
/// transactions, not a number). Paginated instead, same tool catalog
/// discovery already uses for its own unbounded-but-real-signal lists
/// (architecture plan §9.3) -- a transaction history is signal, not
/// noise, so bucketing would be the wrong tool; bounding page size is the
/// right one. `GetStrategy::Local`, same reasoning as `get_balance`.
#[hdk_extern]
pub fn list_my_transactions(input: ListMyTransactionsInput) -> ExternResult<TransactionsPage> {
    let me = agent_info()?.agent_initial_pubkey;
    let mut query = LinkQuery::try_new(me, LinkTypes::AgentToTransaction)?;
    query.after = input.after;
    let mut links = get_links(query, GetStrategy::Local)?;
    links.sort_by_key(|l| l.timestamp);
    let next_after = if links.len() > TRANSACTION_PAGE_SIZE {
        Some(next_page_cursor(links[TRANSACTION_PAGE_SIZE - 1].timestamp))
    } else {
        None
    };
    links.truncate(TRANSACTION_PAGE_SIZE);
    let mut transactions = Vec::with_capacity(links.len());
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if let Some(record) = get(action_hash, GetOptions::local())? {
            transactions.push(record);
        }
    }
    Ok(TransactionsPage { transactions, next_after })
}

#[cfg(feature = "test-utils")]
mod test_utils {
    use hdk::prelude::*;
    use ledger_integrity::LinkTypes;
    relay_coordinator_support::raw_link_test_externs!(AgentToTransaction, AgentToBalanceCheckpoint);
}
