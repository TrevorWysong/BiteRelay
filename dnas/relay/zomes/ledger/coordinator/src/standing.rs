//! Where an account's ledger stood at a point in its history -- what an
//! issuer reissues when the account is recovered (its key lost), or carries
//! to the next network when it migrates.

use crate::{entry_of, guest};
use hdk::prelude::*;
use ledger_integrity::*;

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
}

/// An account's ledger as of `head`, whatever happened on it after.
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
    let Some((_, latest)) = activity.last() else { return Ok(Standing { balance: 0 }) };
    let record = get(latest.clone(), GetOptions::default())?.ok_or(guest("couldn't read that ledger entry"))?;
    let entry = entry_of(&record).ok_or(guest("that isn't a ledger entry"))?;
    Ok(Standing { balance: entry.balance })
}
