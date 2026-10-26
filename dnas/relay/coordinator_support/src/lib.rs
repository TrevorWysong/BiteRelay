//! Small helpers shared across coordinator zomes. Nothing here is zome-
//! specific -- it exists so each coordinator crate doesn't have to
//! reimplement the same low-level HDK plumbing.

use hdk::prelude::*;
use relay_integrity_support::limits::SEAL_CHUNK_BYTES;
pub use relay_integrity_support::SealedChunks;

/// The original creation action behind `action_hash` -- itself, unless
/// it's an update, in which case its chain of updates is walked back. The
/// coordinator-side twin of `relay_integrity_support::original_creation`.
pub fn original_action_of(action_hash: ActionHash) -> ExternResult<ActionHash> {
    let mut current = action_hash;
    loop {
        let record = get(current.clone(), GetOptions::default())?
            .ok_or(wasm_error!(WasmErrorInner::Guest(format!("record {current} not found"))))?;
        match &record.action().data {
            ActionData::Update(update) => current = update.original_action_address.clone(),
            _ => return Ok(current),
        }
    }
}

/// Resolves an ActionHash to the record's current state, following its
/// updates. `get()` on an ActionHash is literal -- it returns exactly that
/// action, never its latest update -- so this is what lets every extern take
/// one stable reference (the original action) across any number of edits.
/// Each update must be applied to the *latest* record, too: updating the
/// original again would branch the history instead of extending it.
///
/// Reads locally first (the common case: the caller's own data, or data
/// it already holds) and falls back to the network for a record it doesn't.
pub fn resolve_latest(action_hash: ActionHash) -> ExternResult<Record> {
    match resolve_latest_with(action_hash.clone(), GetOptions::local()) {
        Ok(record) => Ok(record),
        Err(_) => resolve_latest_with(action_hash, GetOptions::network()),
    }
}

/// `resolve_latest`, always asking the network -- for when a stale local
/// copy would be wrong, like pricing an order at an item's current price.
pub fn resolve_latest_fresh(action_hash: ActionHash) -> ExternResult<Record> {
    resolve_latest_with(action_hash, GetOptions::network())
}

/// When an entry's history has branched -- two parties updating an order
/// at once, say -- its current version is the tip of the branch that has
/// gone furthest, and between equally long branches, the one written first.
/// Never the latest timestamp: an author chooses their own timestamps, so
/// "latest" would let anyone win a branch by dating their update ahead.
/// Nothing that moves money depends on which branch this picks -- each
/// party's held money is settled by the exact version it cites (see
/// `ledger_integrity`) -- it's what screens show and what the next update
/// builds on.
fn resolve_latest_with(action_hash: ActionHash, options: GetOptions) -> ExternResult<Record> {
    Ok(deepest(action_hash, &options)?.0)
}

/// The tip of the deepest branch of updates below `action_hash`, and its
/// depth. Between equally deep branches, the one whose first update was
/// written earliest; then the lower action hash, so every peer agrees.
fn deepest(action_hash: ActionHash, options: &GetOptions) -> ExternResult<(Record, u32)> {
    let details = get_details(action_hash, options.clone())?.ok_or(wasm_error!(WasmErrorInner::Guest("record not found".into())))?;
    let Details::Record(record_details) = details else {
        return Err(wasm_error!(WasmErrorInner::Guest("expected Details::Record for an ActionHash query".into())));
    };
    let mut best: Option<(Record, u32, Timestamp, ActionHash)> = None;
    for update in &record_details.updates {
        let (tip, depth) = deepest(update.action_address().clone(), options)?;
        let (written, hash) = (update.action().timestamp(), update.action_address().clone());
        let better = best.as_ref().is_none_or(|(_, d, t, h)| (depth + 1, std::cmp::Reverse(written), std::cmp::Reverse(&hash)) > (*d, std::cmp::Reverse(*t), std::cmp::Reverse(h)));
        if better {
            best = Some((tip, depth + 1, written, hash));
        }
    }
    Ok(match best {
        Some((tip, depth, _, _)) => (tip, depth),
        None => (record_details.record, 0),
    })
}

/// Encrypts `value` from the caller to `recipient` (libsodium box, keyed off
/// both agents' own keys -- nothing to publish or exchange first). Box is
/// symmetric between its two parties: the caller can always re-open what
/// they sealed, so sealing to yourself keeps a value readable only by you.
pub fn seal<T: Serialize + std::fmt::Debug>(recipient: &AgentPubKey, value: &T) -> ExternResult<XSalsa20Poly1305EncryptedData> {
    let me = agent_info()?.agent_initial_pubkey;
    let bytes = ExternIO::encode(value).map_err(|e| wasm_error!(e))?.0;
    ed_25519_x_salsa20_poly1305_encrypt(me, recipient.clone(), XSalsa20Poly1305Data::from(bytes))
}

/// Seals `value` to `recipient` a chunk at a time -- for anything that may
/// be larger than one box holds (a photo); see `SealedChunks`.
pub fn seal_chunked<T: Serialize + std::fmt::Debug>(recipient: &AgentPubKey, value: &T) -> ExternResult<SealedChunks> {
    let me = agent_info()?.agent_initial_pubkey;
    let bytes = ExternIO::encode(value).map_err(|e| wasm_error!(e))?.0;
    let boxes = bytes
        .chunks(SEAL_CHUNK_BYTES)
        .map(|chunk| ed_25519_x_salsa20_poly1305_encrypt(me.clone(), recipient.clone(), XSalsa20Poly1305Data::from(chunk.to_vec())))
        .collect::<ExternResult<Vec<_>>>()?;
    Ok(SealedChunks(boxes))
}

/// Opens `seal_chunked`'s boxes, as `open` does one -- `None` unless the
/// caller can open every one.
pub fn open_chunked<T: for<'de> Deserialize<'de> + std::fmt::Debug>(counterpart: &AgentPubKey, sealed: &SealedChunks) -> ExternResult<Option<T>> {
    let me = agent_info()?.agent_initial_pubkey;
    let mut bytes = Vec::new();
    for sealed_box in &sealed.0 {
        let Ok(chunk) = ed_25519_x_salsa20_poly1305_decrypt(me.clone(), counterpart.clone(), sealed_box.clone()) else { return Ok(None) };
        bytes.extend_from_slice(chunk.as_ref());
    }
    Ok(ExternIO(bytes).decode().ok())
}

/// Opens a box exchanged between the caller and `counterpart`, sealed in
/// either direction (`counterpart` is the caller themselves for something
/// they sealed to themselves). `None` when the caller isn't one of its two
/// parties.
pub fn open<T: for<'de> Deserialize<'de> + std::fmt::Debug>(counterpart: &AgentPubKey, sealed: &XSalsa20Poly1305EncryptedData) -> ExternResult<Option<T>> {
    let me = agent_info()?.agent_initial_pubkey;
    let Ok(data) = ed_25519_x_salsa20_poly1305_decrypt(me, counterpart.clone(), sealed.clone()) else { return Ok(None) };
    Ok(ExternIO(data.as_ref().to_vec()).decode().ok())
}

/// The next page's `after` cursor, given the last link in this page.
/// `LinkQuery.after` is inclusive (`>=`), so the cursor steps one
/// microsecond past the last link. Two links in the same microsecond can
/// straddle a page boundary -- acceptable for a browsing list; `ledger`'s
/// balance math, which can't tolerate it, excludes by hash instead.
pub fn next_page_cursor(last_included: Timestamp) -> Timestamp {
    Timestamp::from_micros(last_included.as_micros() + 1)
}

/// The record's entry as a `T`, or `None` if it isn't one.
/// `to_app_option::<T>()` returns `Err` (not `Ok(None)`) for an entry of a
/// different type, so `?` on it turns "that reference isn't a T" into an
/// opaque decode error. Use this for references a caller supplied, which
/// could point at anything; keep `?` where the type is guaranteed.
pub fn decode_or<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(record: &Record) -> Option<T> {
    match record.entry().to_app_option::<T>() {
        Ok(Some(v)) => Some(v),
        _ => None,
    }
}

/// `resolve_latest`, decoded as a `T` -- or an error naming what was
/// expected. Returns the record too, since most callers update it next.
pub fn resolve_latest_decoded<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(
    action_hash: ActionHash,
    type_name: &str,
) -> ExternResult<(Record, T)> {
    let record = resolve_latest(action_hash)?;
    let decoded = record
        .entry()
        .to_app_option::<T>()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(format!("record is not a {type_name}"))))?;
    Ok((record, decoded))
}

/// Each link's target at its current state (via `resolve_latest`), skipping
/// any that don't resolve -- one bad link shouldn't fail a whole list.
pub fn resolve_links_to_records(links: Vec<Link>) -> Vec<Record> {
    let mut out = Vec::with_capacity(links.len());
    for link in links {
        let Some(hash) = link.target.into_action_hash() else { continue };
        if let Ok(record) = resolve_latest(hash) {
            out.push(record);
        }
    }
    out
}

/// Like `resolve_links_to_records`, keeping each link's target -- the
/// entry's original action, its stable identity -- next to its latest
/// record. The latest record's own hash changes on every update, so it
/// can never stand in for the identity other entries reference.
pub fn resolve_links_to_records_with_original(links: Vec<Link>) -> Vec<(ActionHash, Record)> {
    let mut out = Vec::with_capacity(links.len());
    for link in links {
        let Some(hash) = link.target.into_action_hash() else { continue };
        if let Ok(record) = resolve_latest(hash.clone()) {
            out.push((hash, record));
        }
    }
    out
}

/// The `(ScopedEntryDefIndex, EntryVisibility)` a chain `query()` filter
/// needs, from an `EntryTypes` value. (`EntryType::try_from(UnitEntryTypes::X)`
/// does the same without needing a value, and is preferred.)
pub fn entry_def_parts<'a, E>(entry: &'a E) -> ExternResult<(ScopedEntryDefIndex, EntryVisibility)>
where
    &'a E: TryInto<ScopedEntryDefIndex, Error = WasmError>,
    EntryVisibility: From<&'a E>,
{
    let scoped: ScopedEntryDefIndex = entry.try_into().map_err(|e: WasmError| e)?;
    let visibility = EntryVisibility::from(entry);
    Ok((scoped, visibility))
}


/// Test-only externs for proving link validation: raw `create_link` /
/// `delete_link`, which an honest coordinator never exposes, so a test can
/// attempt exactly the links a malicious peer would and assert they're
/// rejected. Each coordinator invokes this behind its `test-utils` feature;
/// that build is only ever hot-swapped into test conductors (coordinators
/// aren't part of the DNA hash), never packed into the shipped hApp.
///
/// List every link type the zome defines; `link_type` is matched by name.
#[macro_export]
macro_rules! raw_link_test_externs {
    ($($variant:ident),+ $(,)?) => {
        fn parse_link_type(name: &str) -> ExternResult<LinkTypes> {
            match name {
                $(stringify!($variant) => Ok(LinkTypes::$variant),)+
                other => Err(wasm_error!(WasmErrorInner::Guest(format!("unknown link type {other}")))),
            }
        }

        #[derive(Serialize, Deserialize, Debug)]
        pub struct RawLinkInput {
            pub link_type: String,
            pub base: AnyLinkableHash,
            pub target: AnyLinkableHash,
            #[serde(default)]
            pub tag: Vec<u8>,
        }

        #[hdk_extern]
        pub fn test_create_link(input: RawLinkInput) -> ExternResult<ActionHash> {
            create_link(input.base, input.target, parse_link_type(&input.link_type)?, LinkTag::new(input.tag))
        }

        #[hdk_extern]
        pub fn test_delete_link(create_link_hash: ActionHash) -> ExternResult<ActionHash> {
            delete_link(create_link_hash, GetOptions::default())
        }

        #[derive(Serialize, Deserialize, Debug)]
        pub struct RawLinkQuery {
            pub link_type: String,
            pub base: AnyLinkableHash,
        }

        /// An anchor path's hash, so a test can address a path-based base.
        #[hdk_extern]
        pub fn test_path_hash(path: String) -> ExternResult<AnyLinkableHash> {
            Ok(hdi::hash_path::path::Path::from(path).path_entry_hash()?.into())
        }

        /// The create-link hashes under `base`, so a test can try deleting one.
        #[hdk_extern]
        pub fn test_get_link_hashes(input: RawLinkQuery) -> ExternResult<Vec<ActionHash>> {
            let links = get_links(LinkQuery::try_new(input.base, parse_link_type(&input.link_type)?)?, GetStrategy::default())?;
            Ok(links.into_iter().map(|link| link.create_link_hash).collect())
        }
    };
}

/// `agent`'s valid actions matching `filter`, oldest first: as the network's
/// authorities for them report it, or -- when they report nothing, as for an
/// agent on this same node, whose authority the network lookup skips --
/// what this node already holds, which it validated too.
pub fn agent_activity(agent: AgentPubKey, filter: ChainQueryFilter) -> ExternResult<Vec<(u32, ActionHash)>> {
    let network = get_agent_activity(agent.clone(), filter.clone(), ActivityRequest::Full, GetOptions::default())?.valid_activity;
    if !network.is_empty() {
        return Ok(network);
    }
    Ok(get_agent_activity(agent, filter, ActivityRequest::Full, GetOptions::local())?.valid_activity)
}

/// Lets any agent call `functions` of the calling zome on this device: a
/// zome-call grant with no constraint, written (privately) unless this
/// device already holds it. What `send_remote_signal` needs to reach
/// `recv_remote_signal`, which Holochain refuses without a grant, and what
/// a giver's conductor needs to answer a typed handoff code. Returns
/// whether it wrote one.
///
/// A grant's entry is private, so it lives only on the device that wrote
/// it: an account restored onto a new device from the network
/// (RECOVERY.md) has the grant's action but not the grant. Each zome's
/// `prepare_device` calls this on every start, so a device always ends up
/// holding its own.
pub fn ensure_open_calls(tag: &str, functions: &[&str]) -> ExternResult<bool> {
    let zome = zome_info()?.name;
    let functions: GrantedFunctions = GrantedFunctions::Listed(functions.iter().map(|f| (zome.clone(), FunctionName::from(*f))).collect());
    let held = query(ChainQueryFilter::new().entry_type(EntryType::CapGrant).include_entries(true))?.into_iter().any(|record| {
        matches!(
            record.entry().as_option(),
            Some(Entry::CapGrant(CapGrantEntry { tag: held_tag, constraint: GrantConstraint::Unrestricted, capability: Capability::ZomeCall(ZomeCallGrant { functions: held }) }))
                if held_tag == tag && held == &functions
        )
    });
    if held {
        return Ok(false);
    }
    create_cap_grant(CapGrantEntry::new_zome_call_grant(tag.into(), GrantConstraint::Unrestricted, functions))?;
    Ok(true)
}
