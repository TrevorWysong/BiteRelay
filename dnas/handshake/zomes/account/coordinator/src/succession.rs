//! A new key recovering an account whose key was lost: on the recovery
//! phrase, or on guardians. Its balance is reissued by an issuer
//! (`request_reissue`); see docs/RECOVERY.md.

use crate::{decoded, guest, linked_records, own_links, recovery_plan_of};
use account_integrity::*;
use hdk::prelude::*;

/// How far back an account's line of keys is followed.
const MAX_LINEAGE: usize = 16;

/// The caller recovering `succession.predecessor`'s account.
#[hdk_extern]
pub fn take_over(succession: Succession) -> ExternResult<ActionHash> {
    if my_succession(())?.is_some() {
        return Err(guest("This device has already taken over an account."));
    }
    let predecessor = succession.predecessor.clone();
    let hash = create_entry(&EntryTypes::Succession(succession))?;
    create_link(predecessor, hash.clone(), LinkTypes::PredecessorToSuccession, ())?;
    create_link(agent_info()?.agent_initial_pubkey, hash.clone(), LinkTypes::SuccessorToSuccession, ())?;
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuccessionKind {
    Phrase,
    Guardians,
}

/// One key taking over another's account.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SuccessionView {
    pub succession: ActionHash,
    pub predecessor: AgentPubKey,
    pub successor: AgentPubKey,
    pub kind: SuccessionKind,
    /// The plan the recovery rested on.
    pub plan: ActionHash,
    pub at: Timestamp,
}

fn view_of(record: &Record) -> Option<SuccessionView> {
    let succession = decoded::<Succession>(record)?;
    let (kind, plan) = match succession.authority {
        Authority::Phrase { plan, .. } => (SuccessionKind::Phrase, plan),
        Authority::Guardians { plan, .. } => (SuccessionKind::Guardians, plan),
    };
    Some(SuccessionView { succession: record.action_address().clone(), predecessor: succession.predecessor, successor: record.action().author().clone(), kind, plan, at: record.action().timestamp() })
}

/// Whether a recovery still stands: while its plan is still the account's
/// current one. Validation
/// can only check the plan was current as of the point in the account's
/// history the recovery cites -- which could be an old point, before the
/// person replaced a phrase that leaked or dropped a guardian. So everyone
/// asks again when they look, and a replaced plan recovers nothing.
fn stands(view: &SuccessionView) -> ExternResult<bool> {
    Ok(recovery_plan_of(view.predecessor.clone())?.is_some_and(|current| current.plan == view.plan))
}

/// The account the caller's key took over, if it did.
#[hdk_extern]
pub fn my_succession(_: ()) -> ExternResult<Option<SuccessionView>> {
    Ok(crate::my_linked(LinkTypes::SuccessorToSuccession)?.first().and_then(view_of))
}

/// Every key that has taken over `account` and still stands (`stands`) --
/// none while it's in use. More than one means someone recovered it who
/// shouldn't have, or it was recovered twice: apps treat it as moved on
/// either way, and its issuer reissues nothing until a person looks.
#[hdk_extern]
pub fn successions_of(account: AgentPubKey) -> ExternResult<Vec<SuccessionView>> {
    let mut standing = Vec::new();
    for view in linked_records(LinkQuery::try_new(account.clone(), LinkTypes::PredecessorToSuccession)?, GetStrategy::default())?.iter().filter_map(view_of) {
        if view.predecessor == account && stands(&view)? {
            standing.push(view);
        }
    }
    Ok(standing)
}

/// The keys `agent`'s account had before it, newest first -- whose ratings
/// and history are its own.
#[hdk_extern]
pub fn lineage(agent: AgentPubKey) -> ExternResult<Vec<AgentPubKey>> {
    let mut line: Vec<AgentPubKey> = Vec::new();
    let mut current = agent;
    while line.len() < MAX_LINEAGE {
        let Some(view) = linked_records(own_links(&current, LinkTypes::SuccessorToSuccession)?, GetStrategy::default())?.iter().filter_map(view_of).find(|v| v.successor == current) else { break };
        if line.contains(&view.predecessor) || !stands(&view)? {
            break;
        }
        line.push(view.predecessor.clone());
        current = view.predecessor;
    }
    Ok(line)
}

/// The latest action the network has seen on `agent`'s chain -- where their
/// account stands, for a recovery to cite.
#[hdk_extern]
pub fn latest_action_of(agent: AgentPubKey) -> ExternResult<Option<ActionHash>> {
    handshake_coordinator_support::chain::chain_head_of(&agent)
}

/// When `agent`'s account began: the first action of the oldest key in its
/// line -- a recovered account keeps its age. What an issuer
/// weighs, among other things, in how much it lets a card add at once.
#[hdk_extern]
pub fn account_since(agent: AgentPubKey) -> ExternResult<Option<Timestamp>> {
    let first = lineage(agent.clone())?.pop().unwrap_or(agent);
    let genesis = ChainQueryFilter::new().sequence_range(ChainQueryFilterRange::ActionSeqRange(0, 0));
    let Some((_, hash)) = handshake_coordinator_support::agent_activity(first, genesis)?.into_iter().next() else { return Ok(None) };
    Ok(get(hash, GetOptions::default())?.map(|record| record.action().timestamp()))
}
