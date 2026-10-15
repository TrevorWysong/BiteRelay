//! Handing an account to a new key, and taking it in -- the money half of
//! moving to a new device (the account zome carries the rest). See
//! `ledger_integrity` for what validation guarantees: the old key's ledger
//! closes on its hand-over, and its successor takes it in once.

use crate::{append, entry_of, guest, my_entries};
use hdk::prelude::*;
use ledger_integrity::*;

/// Hands the caller's account to `successor`: their whole balance, in their
/// last ledger entry. Refused while one of their stores is listed -- its
/// stake comes back only to the key that put it up, by taking the listing
/// down. Called by the account zome as it hands over, so the two commit
/// together.
#[hdk_extern]
pub fn hand_over(successor: AgentPubKey) -> ExternResult<ActionHash> {
    let entries: Vec<LedgerEntry> = my_entries()?.iter().filter_map(entry_of).collect();
    let staked = entries.iter().filter(|e| matches!(e.kind, LedgerKind::Stake { .. })).count();
    let unstaked = entries.iter().filter(|e| matches!(e.kind, LedgerKind::Unstake { .. })).count();
    if staked > unstaked {
        return Err(guest("Take your stores' listings down first: their stakes come back only to this device."));
    }
    let balance = entries.last().map_or(0, |e| e.balance);
    let amount = u64::try_from(balance).map_err(|_| guest("Add funds to bring your balance back to zero before moving."))?;
    let hash = append(LedgerKind::HandOver { successor: successor.clone() }, amount)?;
    create_link(successor, hash.clone(), LinkTypes::SuccessorToBequest, ())?;
    Ok(hash)
}

/// Takes in every account handed over to the caller that they haven't yet;
/// returns how many. Safe to repeat.
#[hdk_extern]
pub fn collect_bequests(_: ()) -> ExternResult<u32> {
    let me = agent_info()?.agent_initial_pubkey;
    let taken: Vec<ActionHash> = my_entries()?
        .iter()
        .filter_map(entry_of)
        .filter_map(|e| match e.kind {
            LedgerKind::Inherit { bequest } => Some(bequest),
            _ => None,
        })
        .collect();
    let mut count = 0;
    for link in get_links(LinkQuery::try_new(me.clone(), LinkTypes::SuccessorToBequest)?, GetStrategy::default())? {
        let Some(bequest) = link.target.into_action_hash() else { continue };
        if taken.contains(&bequest) {
            continue;
        }
        let Some(record) = get(bequest.clone(), GetOptions::default())? else { continue };
        let Some(LedgerEntry { kind: LedgerKind::HandOver { successor }, amount, .. }) = entry_of(&record) else { continue };
        if successor != me {
            continue;
        }
        append(LedgerKind::Inherit { bequest }, amount)?;
        count += 1;
    }
    Ok(count)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct StandingInput {
    pub agent: AgentPubKey,
    /// An action on `agent`'s chain.
    pub head: ActionHash,
}

/// Where an account's ledger stood as of an action on its chain.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Standing {
    pub balance: i64,
    /// Whether it had already been handed over -- nothing more to recover.
    pub handed_over: bool,
}

/// An account's ledger as of `head` -- what an issuer reissues when the
/// account is recovered (its key lost), whatever happened on it after.
#[hdk_extern]
pub fn standing_at(input: StandingInput) -> ExternResult<Standing> {
    let head = get(input.head.clone(), GetOptions::default())?.ok_or(guest("That point in the account's history isn't reachable yet."))?;
    if head.action().author() != &input.agent {
        return Err(guest("That isn't on this account's chain."));
    }
    let filter = ChainQueryFilter::new()
        .entry_type(EntryType::try_from(UnitEntryTypes::LedgerEntry)?)
        .sequence_range(ChainQueryFilterRange::ActionSeqRange(0, head.action().action_seq()));
    let activity = relay_coordinator_support::agent_activity(input.agent, filter)?;
    let Some((_, latest)) = activity.last() else { return Ok(Standing { balance: 0, handed_over: false }) };
    let record = get(latest.clone(), GetOptions::default())?.ok_or(guest("couldn't read that ledger entry"))?;
    let entry = entry_of(&record).ok_or(guest("that isn't a ledger entry"))?;
    Ok(Standing { balance: entry.balance, handed_over: matches!(entry.kind, LedgerKind::HandOver { .. }) })
}

/// An account handed over to the caller.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BequestView {
    pub bequest: ActionHash,
    pub from: AgentPubKey,
    pub amount: u64,
    pub at: Timestamp,
}

/// Every account handed over to the caller's key -- what a new device waits
/// for after showing its code to the old one.
#[hdk_extern]
pub fn bequests_to_me(_: ()) -> ExternResult<Vec<BequestView>> {
    let me = agent_info()?.agent_initial_pubkey;
    let mut bequests = Vec::new();
    for link in get_links(LinkQuery::try_new(me.clone(), LinkTypes::SuccessorToBequest)?, GetStrategy::default())? {
        let Some(bequest) = link.target.into_action_hash() else { continue };
        let Some(record) = get(bequest.clone(), GetOptions::default())? else { continue };
        let Some(LedgerEntry { kind: LedgerKind::HandOver { successor }, amount, .. }) = entry_of(&record) else { continue };
        if successor == me {
            bequests.push(BequestView { bequest, from: record.action().author().clone(), amount, at: record.action().timestamp() });
        }
    }
    Ok(bequests)
}
