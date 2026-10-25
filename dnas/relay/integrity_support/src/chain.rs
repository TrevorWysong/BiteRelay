//! Walks of an author's own chain -- how validation sees what they've
//! already done, so a rule that holds "once" or "at most so many" can't be
//! dodged on another branch of an entry's history. Skipping part of a chain
//! would need a fork, which Holochain detects and warrants.

use hdi::prelude::*;

/// How many actions a walk back to a time reads first. Each further read
/// takes twice as many, up to `LONGEST_READ`: a walk over `n` actions costs
/// about log2(n / 32) reads and at most twice the actions it needed.
const FIRST_READ: u32 = 32;
const LONGEST_READ: u32 = 4_096;

/// `author`'s actions from `chain_top` back to the first at or after
/// `since`, newest first -- none if the chain hadn't reached `since` yet.
/// With `entries`, each carries its entry where the authority has it.
///
/// Read in counted steps (`ChainFilter::take`) rather than as one
/// `until_timestamp` filter: Holochain reads a counted range straight from
/// its index, while a timestamp bound reads the author's whole chain and
/// filters after. This way a walk costs what happened since `since`, not
/// how long the chain is -- what keeps a busy store's checks cheap. Sound
/// because an action is never older than the one before it (Holochain's
/// own validation), so the first one before `since` ends the walk, and
/// each step depends only on where it starts, so every validator reads the
/// same actions.
pub fn activity_since(author: &AgentPubKey, chain_top: &ActionHash, since: Timestamp, entries: bool) -> ExternResult<Vec<AgentActivity>> {
    let mut walked = Vec::new();
    let mut from = Some(chain_top.clone());
    let mut count = FIRST_READ;
    while let Some(top) = from.take() {
        let filter = ChainFilter::take(top, count);
        let read = must_get_agent_activity(author.clone(), if entries { filter.include_cached_entries() } else { filter })?;
        let reached_genesis = read.len() < count as usize;
        for item in read {
            let action = &item.action.hashed.content;
            if action.timestamp() < since {
                return Ok(walked);
            }
            from = action.prev_action().cloned();
            walked.push(item);
        }
        if reached_genesis {
            break;
        }
        count = (count * 2).min(LONGEST_READ);
    }
    Ok(walked)
}

/// The entries of the given types that `author` created within `filter`,
/// newest first, as bytes to decode.
pub fn entries_created(author: &AgentPubKey, filter: ChainFilter, types: &[ScopedEntryDefIndex]) -> ExternResult<Vec<SerializedBytes>> {
    created_of(must_get_agent_activity(author.clone(), filter.include_cached_entries())?, types)
}

/// The entries of the given types created among `activity`, as bytes.
fn created_of(activity: Vec<AgentActivity>, types: &[ScopedEntryDefIndex]) -> ExternResult<Vec<SerializedBytes>> {
    let mut entries = Vec::new();
    for item in activity {
        let ActionData::Create(create) = &item.action.hashed.content.data else { continue };
        let EntryType::App(def) = &create.entry_type else { continue };
        if !types.iter().any(|t| t.zome_index == def.zome_index && t.zome_type == def.entry_index) {
            continue;
        }
        if let Entry::App(bytes) = entry_of(&item, &create.entry_hash)? {
            entries.push(SerializedBytes::from(bytes));
        }
    }
    Ok(entries)
}

/// The entry an action in a walk wrote: the cached copy the walk carried,
/// else fetched.
pub fn entry_of(item: &AgentActivity, entry_hash: &EntryHash) -> ExternResult<Entry> {
    match &item.cached_entry {
        Some(entry) => Ok(entry.clone()),
        None => Ok(must_get_entry(entry_hash.clone())?.content),
    }
}

/// The same, from `chain_top` back to the first action at or after `since`
/// -- none if the chain hadn't reached `since` yet.
pub fn entries_since(author: &AgentPubKey, chain_top: &ActionHash, since: Timestamp, types: &[ScopedEntryDefIndex]) -> ExternResult<Vec<SerializedBytes>> {
    created_of(activity_since(author, chain_top, since, true)?, types)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A chain of `len` actions, one a second, served the way the conductor
    /// serves a counted read; counts the actions handed out.
    struct FakeChain {
        actions: Vec<SignedActionHashed>,
        read: Arc<AtomicUsize>,
    }

    fn author() -> AgentPubKey {
        AgentPubKey::from_raw_36(vec![7; 36])
    }

    fn chain(len: u32) -> (Vec<SignedActionHashed>, Arc<AtomicUsize>) {
        let mut actions: Vec<SignedActionHashed> = Vec::new();
        for seq in 0..len {
            let header = ActionHeader {
                author: author(),
                timestamp: Timestamp::from_micros(seq as i64 * 1_000_000),
                action_seq: seq,
                prev_action: actions.last().map(|a| a.hashed.hash.clone()),
            };
            let data = if seq == 0 { ActionData::Dna(DnaData { dna_hash: DnaHash::from_raw_36(vec![1; 36]) }) } else { ActionData::InitZomesComplete(InitZomesCompleteData {}) };
            actions.push(SignedActionHashed::with_presigned(ActionHashed::from_content_sync(Action { header, data }), Signature([0; 64])));
        }
        let read = Arc::new(AtomicUsize::new(0));
        set_hdi(FakeChain { actions: actions.clone(), read: read.clone() });
        (actions, read)
    }

    fn at(seconds: i64) -> Timestamp {
        Timestamp::from_micros(seconds * 1_000_000)
    }

    fn seqs(walked: &[AgentActivity]) -> Vec<u32> {
        walked.iter().map(|a| a.action.hashed.content.action_seq()).collect()
    }

    #[test]
    fn walks_back_to_the_first_action_at_or_after_the_time() {
        let (actions, _) = chain(500);
        let top = actions[499].hashed.hash.clone();
        assert_eq!(seqs(&activity_since(&author(), &top, at(400), false).unwrap()), (400..500).rev().collect::<Vec<_>>());
        assert_eq!(seqs(&activity_since(&author(), &top, at(499), false).unwrap()), vec![499]);
    }

    #[test]
    fn nothing_when_the_chain_had_not_reached_the_time() {
        let (actions, _) = chain(50);
        assert!(activity_since(&author(), &actions[49].hashed.hash, at(60), false).unwrap().is_empty());
    }

    #[test]
    fn stops_at_genesis() {
        let (actions, _) = chain(100);
        assert_eq!(activity_since(&author(), &actions[99].hashed.hash, at(0), false).unwrap().len(), 100);
        let (actions, _) = chain(1);
        assert_eq!(seqs(&activity_since(&author(), &actions[0].hashed.hash, at(0), false).unwrap()), vec![0]);
    }

    #[test]
    fn reads_what_happened_since_the_time_not_the_whole_chain() {
        let (actions, read) = chain(20_000);
        let walked = activity_since(&author(), &actions[19_999].hashed.hash, at(19_900), false).unwrap();
        assert_eq!(walked.len(), 100);
        // 32 + 64 + 128: three reads, under twice what was needed plus the first.
        assert_eq!(read.load(Ordering::SeqCst), 224);
    }

    impl HdiT for FakeChain {
        fn must_get_agent_activity(&self, input: MustGetAgentActivityInput) -> ExternResult<Vec<AgentActivity>> {
            let filter = input.chain_filter;
            assert!(filter.get_until_timestamp().is_none() && filter.get_until_hash().is_none(), "only counted reads");
            let take = filter.get_take().expect("a counted read") as usize;
            let top = self.actions.iter().position(|a| a.hashed.hash == filter.chain_top).expect("the top is on the chain");
            let served: Vec<AgentActivity> = self.actions[..=top].iter().rev().take(take).map(|action| AgentActivity { action: action.clone(), cached_entry: None }).collect();
            self.read.fetch_add(served.len(), Ordering::SeqCst);
            Ok(served)
        }
        fn verify_signature(&self, _: VerifySignature) -> ExternResult<bool> {
            unimplemented!()
        }
        fn must_get_entry(&self, _: MustGetEntryInput) -> ExternResult<EntryHashed> {
            unimplemented!()
        }
        fn must_get_action(&self, _: MustGetActionInput) -> ExternResult<SignedActionHashed> {
            unimplemented!()
        }
        fn must_get_valid_record(&self, _: MustGetValidRecordInput) -> ExternResult<Record> {
            unimplemented!()
        }
        fn dna_info(&self, _: ()) -> ExternResult<DnaInfo> {
            unimplemented!()
        }
        fn zome_info(&self, _: ()) -> ExternResult<ZomeInfo> {
            unimplemented!()
        }
        fn trace(&self, _: TraceMsg) -> ExternResult<()> {
            Ok(())
        }
        fn x_salsa20_poly1305_decrypt(&self, _: XSalsa20Poly1305Decrypt) -> ExternResult<Option<XSalsa20Poly1305Data>> {
            unimplemented!()
        }
        fn x_25519_x_salsa20_poly1305_decrypt(&self, _: X25519XSalsa20Poly1305Decrypt) -> ExternResult<Option<XSalsa20Poly1305Data>> {
            unimplemented!()
        }
        fn ed_25519_x_salsa20_poly1305_decrypt(&self, _: Ed25519XSalsa20Poly1305Decrypt) -> ExternResult<XSalsa20Poly1305Data> {
            unimplemented!()
        }
    }
}
