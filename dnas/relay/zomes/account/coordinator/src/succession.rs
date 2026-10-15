//! A new key taking an account over: handed over by the old device, or
//! recovered when it's lost. The money moves in the ledger zome, called
//! from here so the two commit together.

use crate::{decoded, guest, linked_records, me, recovery_plan_of};
use account_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{open_chunked, seal_chunked};

/// How far back an account's line of keys is followed.
const MAX_LINEAGE: usize = 16;

#[derive(Serialize, Deserialize, Debug)]
pub struct HandOverInput {
    /// The key on the new device.
    pub successor: AgentPubKey,
    /// What only this key can read, for the new one (the app's own
    /// encoding) -- empty for nothing.
    pub parcel: String,
}

/// Hands the caller's account to `successor`: seals `parcel` to it, then
/// passes on the whole balance in the ledger's final entry. After this the
/// caller's key can't spend; the new device carries on.
#[hdk_extern]
pub fn hand_over(input: HandOverInput) -> ExternResult<ActionHash> {
    if input.successor == me()? {
        return Err(guest("That's this device's own key: scan the code on your new device."));
    }
    if input.parcel.len() > MAX_PARCEL_BYTES {
        return Err(guest("There's too much to carry over at once."));
    }
    if !input.parcel.is_empty() {
        let sealed = seal_chunked(&input.successor, &input.parcel)?;
        let hash = create_entry(&EntryTypes::Parcel(Parcel { successor: input.successor.clone(), sealed }))?;
        create_link(input.successor.clone(), hash, LinkTypes::SuccessorToParcel, ())?;
    }
    match call(CallTargetCell::Local, "ledger", "hand_over".into(), None, input.successor)? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e)),
        other => Err(guest(format!("Couldn't hand the account over: {other:?}"))),
    }
}

/// The caller taking over `succession.predecessor`'s account. A hand-over's
/// balance comes with it; a recovered account's is reissued by an issuer
/// (`request_reissue`).
#[hdk_extern]
pub fn take_over(succession: Succession) -> ExternResult<ActionHash> {
    if my_succession(())?.is_some() {
        return Err(guest("This device has already taken over an account."));
    }
    let predecessor = succession.predecessor.clone();
    let handed_over = matches!(succession.authority, Authority::HandOver { .. });
    let hash = create_entry(&EntryTypes::Succession(succession))?;
    create_link(predecessor, hash.clone(), LinkTypes::PredecessorToSuccession, ())?;
    create_link(me()?, hash.clone(), LinkTypes::SuccessorToSuccession, ())?;
    if handed_over && !matches!(call(CallTargetCell::Local, "ledger", "collect_bequests".into(), None, ())?, ZomeCallResponse::Ok(_)) {
        return Err(guest("Couldn't take in the account's balance. Try again."));
    }
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuccessionKind {
    HandOver,
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
    /// The plan a recovery rested on -- none for a hand-over.
    pub plan: Option<ActionHash>,
    pub at: Timestamp,
}

fn view_of(record: &Record) -> Option<SuccessionView> {
    let succession = decoded::<Succession>(record)?;
    let (kind, plan) = match succession.authority {
        Authority::HandOver { .. } => (SuccessionKind::HandOver, None),
        Authority::Phrase { plan, .. } => (SuccessionKind::Phrase, Some(plan)),
        Authority::Guardians { plan, .. } => (SuccessionKind::Guardians, Some(plan)),
    };
    Some(SuccessionView { succession: record.action_address().clone(), predecessor: succession.predecessor, successor: record.action().author().clone(), kind, plan, at: record.action().timestamp() })
}

/// Whether a succession still stands. A hand-over always does. A recovery
/// stands while its plan is still the account's current one: validation
/// can only check the plan was current as of the point in the account's
/// history the recovery cites -- which could be an old point, before the
/// person replaced a phrase that leaked or dropped a guardian. So everyone
/// asks again when they look, and a replaced plan recovers nothing.
fn stands(view: &SuccessionView) -> ExternResult<bool> {
    let Some(plan) = &view.plan else { return Ok(true) };
    Ok(recovery_plan_of(view.predecessor.clone())?.is_some_and(|current| &current.plan == plan))
}

/// The account the caller's key took over, if it did.
#[hdk_extern]
pub fn my_succession(_: ()) -> ExternResult<Option<SuccessionView>> {
    let mine = query(ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::Succession)?).include_entries(true))?;
    Ok(mine.first().and_then(view_of))
}

/// Every key that has taken over `account` and still stands (`stands`) --
/// none while it's in use. More than one means someone recovered it who
/// shouldn't have, or it was recovered twice: apps treat it as moved on
/// either way, and its issuer reissues nothing until a person looks.
#[hdk_extern]
pub fn successions_of(account: AgentPubKey) -> ExternResult<Vec<SuccessionView>> {
    let mut standing = Vec::new();
    for view in linked_records(account.clone(), LinkTypes::PredecessorToSuccession)?.iter().filter_map(view_of) {
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
        let Some(view) = linked_records(current.clone(), LinkTypes::SuccessorToSuccession)?.iter().filter_map(view_of).find(|v| v.successor == current) else { break };
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
    Ok(relay_coordinator_support::agent_activity(agent, ChainQueryFilter::new())?.last().map(|(_, hash)| hash.clone()))
}

/// When `agent`'s account began: the first action of the oldest key in its
/// line -- an account moved to a new phone keeps its age. What an issuer
/// weighs, among other things, in how much it lets a card add at once.
#[hdk_extern]
pub fn account_since(agent: AgentPubKey) -> ExternResult<Option<Timestamp>> {
    let first = lineage(agent.clone())?.pop().unwrap_or(agent);
    let Some((_, hash)) = relay_coordinator_support::agent_activity(first, ChainQueryFilter::new())?.into_iter().next() else { return Ok(None) };
    Ok(get(hash, GetOptions::default())?.map(|record| record.action().timestamp()))
}

/// What the caller's predecessors sealed to them as they handed over, opened.
#[hdk_extern]
pub fn open_parcels(_: ()) -> ExternResult<Vec<String>> {
    let me = me()?;
    let mut parcels = Vec::new();
    for record in linked_records(me.clone(), LinkTypes::SuccessorToParcel)? {
        let Some(parcel) = decoded::<Parcel>(&record) else { continue };
        if parcel.successor != me {
            continue;
        }
        if let Some(contents) = open_chunked::<String>(record.action().author(), &parcel.sealed)? {
            parcels.push(contents);
        }
    }
    Ok(parcels)
}
