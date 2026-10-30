//! Small helpers shared across coordinator zomes. Nothing here is zome-
//! specific -- it exists so each coordinator crate doesn't have to
//! reimplement the same low-level HDK plumbing.

pub mod chain;
pub mod links;

use hdk::prelude::*;
use handshake_integrity_support::limits::SEAL_CHUNK_BYTES;
pub use handshake_integrity_support::SealedChunks;

/// A refusal the person sees: a zome call's error, as a sentence.
pub fn guest(message: impl Into<String>) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message.into()))
}

/// The record the caller just wrote -- what most writing externs answer
/// with. Read from this device: it's on the caller's own chain.
pub fn written(action_hash: ActionHash) -> ExternResult<Record> {
    get(action_hash, GetOptions::local())?.ok_or(guest("couldn't read back what was just written"))
}

/// The original creation action behind `action_hash` -- itself, unless
/// it's an update, in which case its chain of updates is walked back. The
/// coordinator-side twin of `handshake_integrity_support::original_creation`.
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
pub fn resolve_latest(action_hash: ActionHash) -> ExternResult<Record> {
    Ok(resolve_version(action_hash)?.record)
}

/// An entry's current version, and where it stands among its updates --
/// what the next update builds on (`update_version`).
#[derive(Debug, Clone)]
pub struct EntryVersion {
    /// The entry's original action: its identity.
    pub original: ActionHash,
    pub record: Record,
    /// How many updates below the original it is.
    pub depth: u32,
}

impl EntryVersion {
    /// `record`, written on top of this version.
    pub fn next(&self, record: Record) -> Self {
        Self { original: self.original.clone(), record, depth: self.depth + 1 }
    }
}

/// The current version of the entry `action_hash` is (any version of it).
///
/// Each update is linked from the entry's original, tagged with its depth
/// (`handshake_integrity_support::versions`), so this is one read of those
/// links, asked of the network -- current wherever the updates were
/// written -- and one of the version it picks, which never changes once
/// written, so it's read from this device when it's here. Offline, it's
/// the newest version this device has seen.
///
/// When the history has branched -- two parties updating an order at once,
/// say -- the current version is the deepest; between equally deep ones,
/// the one written first, then the lower hash, so every peer agrees. Never
/// the latest timestamp: an author chooses their own timestamps, so
/// "latest" would let anyone win a branch by dating their update ahead.
/// Nothing that moves money depends on which branch this picks -- each
/// party's held money is settled by the exact version it cites (see
/// `ledger_integrity`) -- it's what screens show and what the next update
/// builds on.
pub fn resolve_version(action_hash: ActionHash) -> ExternResult<EntryVersion> {
    let given = read_record(action_hash.clone())?;
    let original = match given.action().data {
        ActionData::Update(_) => original_action_of(action_hash)?,
        _ => action_hash,
    };
    let Some(EntryType::App(def)) = given.action().entry_type() else { return Err(guest("that isn't an entry")) };
    let versions = LinkQuery::new(original.clone(), LinkTypeFilter::single_type(def.zome_index, LinkType(handshake_integrity_support::versions::VERSION_LINK_TYPE)));
    // The network's answer, or -- when it can't be reached -- what this
    // device has seen: older, perhaps, but never nothing.
    let links = get_links(versions.clone(), GetStrategy::Network).or_else(|_| get_links(versions, GetStrategy::Local))?;
    let tip = links
        .into_iter()
        .filter_map(|link| Some((handshake_integrity_support::versions::version_depth(&link.tag)?, link.timestamp, link.target.into_action_hash()?)))
        .max_by(|(d1, t1, h1), (d2, t2, h2)| d1.cmp(d2).then(t2.cmp(t1)).then(h2.cmp(h1)));
    match tip {
        Some((depth, _, hash)) => Ok(EntryVersion { original, record: read_record(hash)?, depth }),
        None if given.action_address() == &original => Ok(EntryVersion { original, record: given, depth: 0 }),
        None => Ok(EntryVersion { record: read_record(original.clone())?, original, depth: 0 }),
    }
}

/// `resolve_version`, decoded as a `T` -- or an error naming what was
/// expected.
pub fn resolve_version_decoded<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(action_hash: ActionHash, type_name: &str) -> ExternResult<(EntryVersion, T)> {
    let version = resolve_version(action_hash)?;
    let decoded = decode_or::<T>(&version.record).ok_or(guest(format!("record is not a {type_name}")))?;
    Ok((version, decoded))
}

/// Writes `entry` as the version after `current` -- the entry's current
/// version (`resolve_version`) -- and links it from the entry's original,
/// tagged with its depth, with the zome's own `Version` link type. Each
/// update builds on the current version: updating an older one would
/// branch the history instead of extending it.
pub fn update_version<I, E, L, LE>(current: &EntryVersion, entry: I, version_link: L) -> ExternResult<ActionHash>
where
    Entry: TryFrom<I, Error = E>,
    WasmError: From<E>,
    ScopedLinkType: TryFrom<L, Error = LE>,
    WasmError: From<LE>,
{
    let updated = update_entry(current.record.action_address().clone(), entry)?;
    create_link(current.original.clone(), updated.clone(), version_link, handshake_integrity_support::versions::version_tag(current.depth + 1))?;
    Ok(updated)
}

/// The version `action_hash` is, current or not -- its original and depth,
/// counted back through its updates. For updating a version the caller
/// names exactly (`resolve_version` finds the current one).
pub fn version_at(action_hash: ActionHash) -> ExternResult<EntryVersion> {
    let record = read_record(action_hash)?;
    let mut depth = 0;
    let mut original = record.clone();
    while let ActionData::Update(update) = &original.action().data {
        depth += 1;
        original = read_record(update.original_action_address.clone())?;
    }
    Ok(EntryVersion { original: original.action_address().clone(), record, depth })
}

/// A record by its action, which never changes once written: from this
/// device when it's here, else the network.
fn read_record(action_hash: ActionHash) -> ExternResult<Record> {
    match get(action_hash.clone(), GetOptions::local())? {
        Some(record) => Ok(record),
        None => get(action_hash, GetOptions::network())?.ok_or(guest("record not found")),
    }
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
pub fn resolve_latest_decoded<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(action_hash: ActionHash, type_name: &str) -> ExternResult<(Record, T)> {
    let (version, decoded) = resolve_version_decoded(action_hash, type_name)?;
    Ok((version.record, decoded))
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
/// zome-call grant with no constraint. What `send_remote_signal` needs to
/// reach `recv_remote_signal`, which Holochain refuses without a grant, and
/// what a giver's conductor needs to answer a typed handoff code. Returns
/// whether it wrote one (`ensure_grant`).
pub fn ensure_open_calls(tag: &str, functions: &[&str]) -> ExternResult<bool> {
    let zome = zome_info()?.name;
    let functions: GrantedFunctions = GrantedFunctions::Listed(functions.iter().map(|f| (zome.clone(), FunctionName::from(*f))).collect());
    ensure_grant(CapGrantEntry::new_zome_call_grant(tag.into(), GrantConstraint::Unrestricted, functions))
}

/// Lets any agent send this device direct signals -- app to app, with no
/// zome code on either end (chat and live location; see the app's
/// `holochain/live.ts`). Holochain drops a direct signal without one, even
/// one from this device's own agent. Returns whether it wrote one.
pub fn ensure_direct_signals(tag: &str) -> ExternResult<bool> {
    ensure_grant(CapGrantEntry::new_direct_signal_grant(tag.into(), GrantConstraint::Unrestricted))
}

/// Writes `grant` (privately) unless this device already holds it.
///
/// A grant's entry is private, so it lives only on the device that wrote
/// it: an account restored onto a new device from the network
/// (docs/RECOVERY.md) has the grant's action but not the grant. Each zome's
/// `prepare_device` ensures its grants on every start, so a device always
/// ends up holding its own.
fn ensure_grant(grant: CapGrantEntry) -> ExternResult<bool> {
    let held = chain::mine(&[EntryType::CapGrant]).creates().any(|record| matches!(record.entry().as_option(), Some(Entry::CapGrant(held)) if held == &grant))?;
    if held {
        return Ok(false);
    }
    create_cap_grant(grant)?;
    Ok(true)
}

/// Calls `function`, one of the calling zome's own externs, in a call of its
/// own, and decodes its answer -- `None` if it failed. For a background
/// sweep over many orders: a zome call commits all its writes or none, so
/// one item's write that doesn't validate (yet) would otherwise undo every
/// other item's, every run, until that one resolves. Each item is its own
/// call; one failing only skips it until the next run.
pub fn isolated<I, O>(function: &str, input: I) -> Option<O>
where
    I: Serialize + std::fmt::Debug,
    O: for<'de> Deserialize<'de> + std::fmt::Debug,
{
    let zome = zome_info().ok()?.name;
    match call(CallTargetCell::Local, zome, function.into(), None, input) {
        Ok(ZomeCallResponse::Ok(io)) => io.decode().ok(),
        _ => None,
    }
}
