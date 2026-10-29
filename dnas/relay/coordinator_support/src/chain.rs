//! Reads of a source chain from its head back, newest first -- the caller's
//! own, or anyone's the network holds.
//!
//! Never `query()`: in Holochain 0.7 it loads the caller's whole chain from
//! the database, with every entry when asked for entries, before applying
//! any filter -- a sequence range included. These walk the chain's index a
//! counted step at a time instead (`relay_integrity_support::chain::
//! walk_back`, what validation reads with too), look at each action alone,
//! and fetch only the records asked for: a read costs what it visits, not
//! how long the chain has grown. Most stop within a few actions -- the
//! latest of a kind, or what happened since a time.

use core::ops::ControlFlow;
use hdk::prelude::*;
use relay_integrity_support::chain::walk_back;

/// Which of the caller's records a walk visits.
pub struct Mine<'a> {
    types: &'a [EntryType],
    since: Option<Timestamp>,
    before: Option<ActionHash>,
    creates_only: bool,
}

/// The caller's records of `types` -- their creations and updates. Each
/// type is `EntryType::try_from(UnitEntryTypes::X)?`.
pub fn mine(types: &[EntryType]) -> Mine<'_> {
    Mine { types, since: None, before: None, creates_only: false }
}

impl Mine<'_> {
    /// Only those written at or after `since`: the walk ends at the first
    /// action before it (an action is never older than the one before it).
    pub fn since(mut self, since: Timestamp) -> Self {
        self.since = Some(since);
        self
    }

    /// Only those written before `action`, one of the caller's -- where a
    /// page left off.
    pub fn before(mut self, action: ActionHash) -> Self {
        self.before = Some(action);
        self
    }

    /// Only creations, not updates.
    pub fn creates(mut self) -> Self {
        self.creates_only = true;
        self
    }

    /// Hands each to `visit`, newest first, until it says to stop. Includes
    /// what this call has written so far.
    pub fn walk(&self, mut visit: impl FnMut(Record) -> ExternResult<ControlFlow<()>>) -> ExternResult<()> {
        let info = agent_info()?;
        let top = self.before.clone().unwrap_or(info.chain_head.0);
        walk_back(&info.agent_initial_pubkey, &top, |item| {
            if self.before.as_ref() == Some(&item.action.hashed.hash) {
                return Ok(ControlFlow::Continue(()));
            }
            let action = &item.action.hashed.content;
            if self.since.is_some_and(|since| action.timestamp() < since) {
                return Ok(ControlFlow::Break(()));
            }
            if !self.matches(action) {
                return Ok(ControlFlow::Continue(()));
            }
            match get(item.action.hashed.hash.clone(), GetOptions::local())? {
                Some(record) => visit(record),
                None => Ok(ControlFlow::Continue(())),
            }
        })
    }

    /// All of them, newest first.
    pub fn records(&self) -> ExternResult<Vec<Record>> {
        let mut out = Vec::new();
        self.walk(|record| {
            out.push(record);
            Ok(ControlFlow::Continue(()))
        })?;
        Ok(out)
    }

    /// The newest -- usually a step or two back.
    pub fn latest(&self) -> ExternResult<Option<Record>> {
        self.find(|_| true)
    }

    /// The newest that `matches`.
    pub fn find(&self, mut matches: impl FnMut(&Record) -> bool) -> ExternResult<Option<Record>> {
        let mut found = None;
        self.walk(|record| {
            if matches(&record) {
                found = Some(record);
                return Ok(ControlFlow::Break(()));
            }
            Ok(ControlFlow::Continue(()))
        })?;
        Ok(found)
    }

    /// Whether any `matches`.
    pub fn any(&self, matches: impl FnMut(&Record) -> bool) -> ExternResult<bool> {
        Ok(self.find(matches)?.is_some())
    }

    fn matches(&self, action: &Action) -> bool {
        let wanted = match &action.data {
            ActionData::Create(create) => &create.entry_type,
            ActionData::Update(update) if !self.creates_only => &update.entry_type,
            _ => return false,
        };
        self.types.contains(wanted)
    }
}

/// The head of `agent`'s chain as the network knows it -- a summary
/// (`ActivityRequest::Status`), not their chain. An agent on this same node
/// is answered from it: the network lookup skips its own authority. So is
/// anyone, when the network can't be reached.
pub fn chain_head_of(agent: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
    for options in [GetOptions::network(), GetOptions::local()] {
        // The network unreachable: what this node holds.
        let Ok(activity) = get_agent_activity(agent.clone(), ChainQueryFilter::new(), ActivityRequest::Status, options) else { continue };
        let head = match activity.status {
            ChainStatus::Valid(head) => Some(head.hash),
            _ => activity.highest_observed.and_then(|seen| seen.hash.into_iter().next()),
        };
        if head.is_some() {
            return Ok(head);
        }
    }
    Ok(None)
}

/// `agent`'s newest action that `matches`, from `from` (an action on their
/// chain) back -- what most questions about someone else's chain need,
/// usually a step or two back.
pub fn latest_on_chain(agent: &AgentPubKey, from: &ActionHash, matches: impl Fn(&Action) -> bool) -> ExternResult<Option<ActionHash>> {
    let mut found = None;
    walk_back(agent, from, |item| {
        if matches(&item.action.hashed.content) {
            found = Some(item.action.hashed.hash);
            return Ok(ControlFlow::Break(()));
        }
        Ok(ControlFlow::Continue(()))
    })?;
    Ok(found)
}

/// `original` -- one of the caller's entries -- and each update they've made
/// since, oldest first: followed through its own updates on this device, a
/// step per version, not found among everything of its type. Empty if the
/// caller didn't write it. Were its history ever to fork, the branch
/// written later wins.
pub fn my_versions(original: ActionHash) -> ExternResult<Vec<Record>> {
    let me = agent_info()?.agent_initial_pubkey;
    let mut versions = Vec::new();
    let mut next = Some(original);
    while let Some(hash) = next.take() {
        let Some(Details::Record(details)) = get_details(hash, GetOptions::local())? else { break };
        if details.record.action().author() != &me {
            break;
        }
        next = details.updates.iter().filter(|u| u.action().author() == &me).max_by_key(|u| u.action().action_seq()).map(|u| u.action_address().clone());
        versions.push(details.record);
    }
    Ok(versions)
}

/// The caller's own entry `original` at its current version, read from this
/// device -- what they update next. `None` if they didn't write it.
pub fn my_current_version(original: ActionHash) -> ExternResult<Option<crate::EntryVersion>> {
    let mut versions = my_versions(original.clone())?;
    let depth = versions.len().saturating_sub(1) as u32;
    Ok(versions.pop().map(|record| crate::EntryVersion { original, record, depth }))
}
