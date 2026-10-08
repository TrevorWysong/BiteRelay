//! Small helpers shared across coordinator zomes. Nothing here is zome-
//! specific -- it exists so each coordinator crate doesn't have to
//! reimplement the same low-level HDK plumbing.

use hdk::prelude::*;

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
pub fn resolve_latest(action_hash: ActionHash) -> ExternResult<Record> {
    let details = get_details(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record not found".into())))?;
    let Details::Record(record_details) = details else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "expected Details::Record for an ActionHash query".into()
        )));
    };
    match record_details.updates.iter().max_by_key(|u| u.action().timestamp()) {
        Some(latest) => resolve_latest(latest.action_address().clone()),
        None => Ok(record_details.record),
    }
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

/// Deterministic, counting-free "is it time to checkpoint" trigger, shared
/// by every checkpoint writer in this codebase (`ledger`'s transaction
/// checkpoints, `reputation`'s event and item-rating checkpoints): derives
/// a pseudo-modulo from the just-created entry's own action hash (already
/// available, no extra read) rather than maintaining a per-agent/per-item
/// counter, which would itself require an O(n) read to keep accurate. This
/// makes checkpoints land *roughly* every `interval` entries on average,
/// not exactly -- fine for a read-cost optimization, not something anything
/// else depends on being precise.
pub fn should_checkpoint(hash: &ActionHash, interval: u64) -> bool {
    (hash.get_raw_36()[0] as u64).is_multiple_of(interval)
}

/// The "find the most recent checkpoint" half of the checkpoint-accelerated
/// read pattern duplicated near-identically across `ledger::get_balance`,
/// `reputation::get_reputation_summary`, and
/// `reputation::get_item_rating_summary` -- walks every checkpoint link from
/// `anchor`, decodes each to `C`, and keeps whichever has the latest
/// `recorded_at` (per caller-supplied `recorded_at`, since each checkpoint
/// type names its own "which action is this checkpoint already as-of"
/// field differently, so that part stays with the caller). `GetStrategy::Local`
/// -- same reasoning as every other checkpoint read in this codebase: a
/// live network round-trip can come back empty even after gossip has
/// already delivered the data locally.
pub fn latest_checkpoint<C, L>(anchor: impl Into<AnyLinkableHash>, link_type: L, recorded_at: impl Fn(&C) -> Timestamp) -> ExternResult<Option<C>>
where
    C: TryFrom<SerializedBytes, Error = SerializedBytesError>,
    L: TryInto<LinkTypeFilter, Error = WasmError>,
{
    let links = get_links(LinkQuery::try_new(anchor, link_type)?, GetStrategy::Local)?;
    let mut latest: Option<C> = None;
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(action_hash, GetOptions::local())? else { continue };
        let Some(checkpoint): Option<C> = decode_or(&record) else { continue };
        let is_newer = latest.as_ref().map(|l| recorded_at(&checkpoint) > recorded_at(l)).unwrap_or(true);
        if is_newer {
            latest = Some(checkpoint);
        }
    }
    Ok(latest)
}

/// The "sum everything since the checkpoint" half of the same pattern (see
/// `latest_checkpoint`'s doc comment) -- walks every link from `anchor`
/// created at or after `since` (`None` scans from the beginning, the no-
/// checkpoint-yet fallback), skips `already_counted` (the one link a found
/// checkpoint's own baseline already reflects -- see `ledger::get_balance`'s
/// doc comment for why `LinkQuery.after` is `>=`, not strictly-greater, and
/// so would otherwise double-count that exact link), decodes each survivor
/// to `T`, and folds it into `acc`. The fold itself (what each entry type
/// actually means for the running total) stays with the caller -- a balance
/// delta, a reputation-kind tally, and a rating sum are different enough
/// shapes that unifying the fold itself would cost more clarity than it
/// saves.
pub fn fold_since_checkpoint<T, L, Acc>(
    anchor: impl Into<AnyLinkableHash>,
    link_type: L,
    since: Option<Timestamp>,
    already_counted: Option<ActionHash>,
    acc: &mut Acc,
    mut fold: impl FnMut(&mut Acc, T),
) -> ExternResult<()>
where
    T: TryFrom<SerializedBytes, Error = SerializedBytesError>,
    L: TryInto<LinkTypeFilter, Error = WasmError>,
{
    let mut query = LinkQuery::try_new(anchor, link_type)?;
    query.after = since;
    let links = get_links(query, GetStrategy::Local)?;
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if already_counted.as_ref() == Some(&action_hash) {
            continue;
        }
        let Some(record) = get(action_hash, GetOptions::local())? else { continue };
        let Some(decoded): Option<T> = decode_or(&record) else { continue };
        fold(acc, decoded);
    }
    Ok(())
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
