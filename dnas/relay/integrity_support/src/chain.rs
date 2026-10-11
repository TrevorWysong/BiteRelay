//! Walks of an author's own chain -- how validation sees what they've
//! already done, so a rule that holds "once" or "at most so many" can't be
//! dodged on another branch of an entry's history. Skipping part of a chain
//! would need a fork, which Holochain detects and warrants.

use hdi::prelude::*;

/// The entries of the given types that `author` created within `filter`,
/// newest first, as bytes to decode.
pub fn entries_created(author: &AgentPubKey, filter: ChainFilter, types: &[ScopedEntryDefIndex]) -> ExternResult<Vec<SerializedBytes>> {
    let mut entries = Vec::new();
    for item in must_get_agent_activity(author.clone(), filter.include_cached_entries())? {
        let ActionData::Create(create) = &item.action.hashed.content.data else { continue };
        let EntryType::App(def) = &create.entry_type else { continue };
        if !types.iter().any(|t| t.zome_index == def.zome_index && t.zome_type == def.entry_index) {
            continue;
        }
        let entry = match item.cached_entry {
            Some(entry) => entry,
            None => must_get_entry(create.entry_hash.clone())?.content,
        };
        if let Entry::App(bytes) = entry {
            entries.push(SerializedBytes::from(bytes));
        }
    }
    Ok(entries)
}

/// The same, from `chain_top` back to the first action at or after `since`
/// -- none if the chain hadn't reached `since` yet.
pub fn entries_since(author: &AgentPubKey, chain_top: &ActionHash, since: Timestamp, types: &[ScopedEntryDefIndex]) -> ExternResult<Vec<SerializedBytes>> {
    if must_get_action(chain_top.clone())?.hashed.content.header.timestamp < since {
        return Ok(Vec::new());
    }
    entries_created(author, ChainFilter::until_timestamp(chain_top.clone(), since), types)
}

/// Whether `author` created an entry of `entry_type` matching `matches`
/// between `chain_top` and `since` -- the "once" rules' question.
pub fn wrote_since<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(
    author: &AgentPubKey,
    chain_top: &ActionHash,
    since: Timestamp,
    entry_type: ScopedEntryDefIndex,
    matches: impl Fn(&T) -> bool,
) -> ExternResult<bool> {
    Ok(entries_since(author, chain_top, since, &[entry_type])?.into_iter().any(|bytes| T::try_from(bytes).is_ok_and(|entry| matches(&entry))))
}
