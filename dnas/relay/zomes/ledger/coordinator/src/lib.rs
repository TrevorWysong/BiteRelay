//! Coordinator zome for the stub mutual-credit ledger: append-only
//! `LedgerTransaction`s recorded by whoever pays, and a derived balance
//! read. See the integrity crate for what validation guarantees.

use hdk::prelude::*;
use ledger_integrity::*;
use relay_coordinator_support::next_page_cursor;
use relay_types::LedgerCommitmentRef;

/// No entry is created here -- there is nothing to "lock" in a mutual-credit
/// model without a settled transaction (see the integrity crate's doc
/// comment). This just produces the reference embedded in a `Bid`; the real
/// transaction is created later by `pay` or `forfeit`.
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

/// The payment or forfeit already on the caller's chain for this order and
/// reason, if any -- what makes `pay`/`forfeit` safe to retry. Payments are
/// authored by their payer, so the caller's own chain is the whole answer.
fn already_recorded(related_order: &ActionHash, reason: &TxnReason, from: &AgentPubKey) -> ExternResult<Option<Record>> {
    let filter = ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::LedgerTransaction)?).include_entries(true);
    Ok(query(filter)?.into_iter().find(|record| {
        record
            .entry()
            .to_app_option::<LedgerTransaction>()
            .ok()
            .flatten()
            .is_some_and(|txn| &txn.related_order == related_order && &txn.reason == reason && &txn.from == from)
    }))
}

fn record_transaction(txn: LedgerTransaction) -> ExternResult<Record> {
    if let Some(existing) = already_recorded(&txn.related_order, &txn.reason, &txn.from)? {
        return Ok(existing);
    }
    let (from, to) = (txn.from.clone(), txn.to.clone());
    let action_hash = create_entry(&EntryTypes::LedgerTransaction(txn))?;
    create_link(from, action_hash.clone(), LinkTypes::AgentToTransaction, ())?;
    create_link(to, action_hash.clone(), LinkTypes::AgentToTransaction, ())?;
    get(action_hash, GetOptions::local())?.ok_or(wasm_error!(WasmErrorInner::Guest("could not read back ledger transaction".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PayInput {
    pub leg: PaymentLeg,
    /// The order being settled (its original action).
    pub related_order: ActionHash,
    /// The order version that completed it -- see `LedgerTransaction::basis`.
    pub basis: ActionHash,
    /// The payer: the caller, unless an arbitrator is settling a ruling.
    pub from: AgentPubKey,
    pub to: AgentPubKey,
    pub amount: u64,
}

/// Records one leg of settling a completed order. Validation accepts it
/// only for exactly what that leg owes, paid by its payer. Safe to retry:
/// a leg already paid returns the existing transaction.
#[hdk_extern]
pub fn pay(input: PayInput) -> ExternResult<Record> {
    record_transaction(LedgerTransaction {
        from: input.from,
        to: input.to,
        amount: input.amount,
        reason: TxnReason::Payment(input.leg),
        related_order: input.related_order,
        basis: input.basis,
        created_at: sys_time()?,
    })
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ForfeitInput {
    pub related_order: ActionHash,
    /// The resolved `Dispute` whose ruling this carries out.
    pub dispute: ActionHash,
    pub from: AgentPubKey,
    pub to: AgentPubKey,
    pub amount: u64,
}

/// An arbitrator moving collateral per their ruling. Safe to retry.
#[hdk_extern]
pub fn forfeit(input: ForfeitInput) -> ExternResult<Record> {
    record_transaction(LedgerTransaction {
        from: input.from,
        to: input.to,
        amount: input.amount,
        reason: TxnReason::CollateralForfeit,
        related_order: input.related_order,
        basis: input.dispute,
        created_at: sys_time()?,
    })
}

/// The orders the caller has already paid `leg` on -- from their own chain,
/// since a payer authors every payment they make.
#[hdk_extern]
pub fn my_paid_orders(leg: PaymentLeg) -> ExternResult<Vec<ActionHash>> {
    let me = agent_info()?.agent_initial_pubkey;
    let filter = ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::LedgerTransaction)?).include_entries(true);
    Ok(query(filter)?
        .into_iter()
        .filter_map(|record| record.entry().to_app_option::<LedgerTransaction>().ok().flatten())
        .filter(|txn| txn.from == me && txn.reason == TxnReason::Payment(leg))
        .map(|txn| txn.related_order)
        .collect())
}

/// A checkpoint is written once this many settled transactions have built
/// up since the last one, so a read sums at most about this many plus
/// whatever arrived inside the settling window.
const CHECKPOINT_EVERY: usize = 20;

/// The agent's latest checkpoint -- only their own count (validation).
fn latest_checkpoint(agent: &AgentPubKey) -> ExternResult<Option<BalanceCheckpoint>> {
    let links = get_links(LinkQuery::try_new(agent.clone(), LinkTypes::AgentToBalanceCheckpoint)?, GetStrategy::default())?;
    let mut latest: Option<BalanceCheckpoint> = None;
    for link in links {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash, GetOptions::default())? else { continue };
        let Ok(Some(checkpoint)) = record.entry().to_app_option::<BalanceCheckpoint>() else { continue };
        if &checkpoint.agent != agent || record.action().author() != agent {
            continue;
        }
        if latest.as_ref().is_none_or(|l| checkpoint.covers_until > l.covers_until) {
            latest = Some(checkpoint);
        }
    }
    Ok(latest)
}

/// Net balance for `agent`: positive means net-received, negative net-paid.
///
/// Sums the transactions since the agent's latest checkpoint. When the
/// agent reads their *own* balance and enough transactions older than the
/// settling window (`relay_governance::balance_settle_window`) have built
/// up, it writes a new checkpoint over exactly those -- never over recent
/// ones, which gossip may still be delivering out of order.
#[hdk_extern]
pub fn get_balance(agent: AgentPubKey) -> ExternResult<i64> {
    let checkpoint = latest_checkpoint(&agent)?;
    let base = checkpoint.as_ref().map_or(0, |c| c.balance);
    let mut query = LinkQuery::try_new(agent.clone(), LinkTypes::AgentToTransaction)?;
    query.after = checkpoint.as_ref().map(|c| c.covers_until);
    let boundary = checkpoint.as_ref().map(|c| c.boundary.clone()).unwrap_or_default();

    let now = sys_time()?;
    let settled_before = Timestamp::from_micros(now.as_micros() - relay_governance::balance_settle_window().as_micros() as i64);
    let mut balance = base;
    let mut settled: Vec<(Timestamp, ActionHash, i64)> = Vec::new();
    for link in get_links(query, GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        if boundary.contains(&hash) {
            continue;
        }
        let Some(record) = get(hash.clone(), GetOptions::default())? else { continue };
        let Ok(Some(txn)) = record.entry().to_app_option::<LedgerTransaction>() else { continue };
        let delta = if txn.to == agent { txn.amount as i64 } else if txn.from == agent { -(txn.amount as i64) } else { 0 };
        balance += delta;
        if link.timestamp <= settled_before {
            settled.push((link.timestamp, hash, delta));
        }
    }

    if settled.len() >= CHECKPOINT_EVERY && agent == agent_info()?.agent_initial_pubkey {
        write_checkpoint(&agent, checkpoint.as_ref(), &settled)?;
    }
    Ok(balance)
}

/// Rolls `settled` into a new checkpoint on top of `previous`.
fn write_checkpoint(agent: &AgentPubKey, previous: Option<&BalanceCheckpoint>, settled: &[(Timestamp, ActionHash, i64)]) -> ExternResult<()> {
    let covers_until = settled.iter().map(|(ts, _, _)| *ts).max().expect("checked non-empty");
    let mut boundary: Vec<ActionHash> = settled.iter().filter(|(ts, _, _)| *ts == covers_until).map(|(_, hash, _)| hash.clone()).collect();
    // Still at the previous checkpoint's boundary time: keep what it already
    // counted there, or the next read would count it again.
    if let Some(previous) = previous.filter(|p| p.covers_until == covers_until) {
        boundary.extend(previous.boundary.iter().cloned());
    }
    let checkpoint = BalanceCheckpoint {
        agent: agent.clone(),
        balance: previous.map_or(0, |p| p.balance) + settled.iter().map(|(_, _, delta)| delta).sum::<i64>(),
        covers_until,
        boundary,
    };
    let action_hash = create_entry(&EntryTypes::BalanceCheckpoint(checkpoint))?;
    create_link(agent.clone(), action_hash, LinkTypes::AgentToBalanceCheckpoint, ())?;
    Ok(())
}

/// How many checkpoints `agent` has written -- for monitoring that they're
/// engaging.
#[hdk_extern]
pub fn count_balance_checkpoints(agent: AgentPubKey) -> ExternResult<u32> {
    let links = get_links(LinkQuery::try_new(agent, LinkTypes::AgentToBalanceCheckpoint)?, GetStrategy::default())?;
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
