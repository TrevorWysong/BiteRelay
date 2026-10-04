//! Small helpers shared across coordinator zomes. Nothing here is zome-
//! specific -- it exists so each coordinator crate doesn't have to
//! reimplement the same low-level HDK plumbing.

use hdk::prelude::*;

/// Resolves an ActionHash to the record's *actual* current state, following
/// the update chain. `get()` on an ActionHash is literal -- it returns
/// exactly that action, never "whatever it was most recently updated to"
/// (that auto-resolution only happens when you query by EntryHash, not
/// ActionHash). Without this, every update-capable extern would need its
/// caller to track and thread the ever-changing latest action hash
/// themselves instead of being able to pass one stable reference (e.g. an
/// entry's original creation hash) across repeated updates.
///
/// Found the hard way while wiring `dispatch`'s order lifecycle: a chain of
/// `Open -> BidAccepted -> MerchantConfirmed -> ...` updates, each passing
/// the same original hash, validated as `Open -> MerchantConfirmed` and
/// failed, because every read was silently resolving back to the original
/// Create instead of the latest Update.
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

/// The next page's `after` cursor, given the last link included in this
/// page. `LinkQuery.after` is `>=`, not strictly-greater (confirmed against
/// the actual holochain_state 0.6.3 SQL, not assumed) -- passing a page's
/// last timestamp straight back as the next page's `after` would return
/// that same boundary link again. Nudging by one microsecond fixes the
/// overwhelmingly common case (distinct timestamps); two links sharing the
/// exact same microsecond is an accepted, named imprecision this pagination
/// doesn't try to solve -- low stakes for a "browse more" UI read, unlike
/// `ledger`'s balance math, which handles its own analogous boundary by
/// excluding a specific known hash instead (see `ledger`'s `get_balance`).
pub fn next_page_cursor(last_included: Timestamp) -> Timestamp {
    Timestamp::from_micros(last_included.as_micros() + 1)
}

/// `record.entry().to_app_option::<T>()` does not cleanly return `Ok(None)`
/// for a genuinely wrong-typed entry -- it returns `Err` (a
/// deserialize-against-the-wrong-schema failure), which a bare
/// `.map_err(...)?`  propagates as an opaque `SerializedBytesError` instead
/// of a clear "not a T" rejection. Found and fixed once in `favorites`'/
/// promo-code validation (a `Profile`/`PromoCode` used as a bogus
/// reference, both structurally incompatible with the expected type);
/// collapses both "wrong type" and "decode error" into the one `None` they
/// both actually mean. Correct whenever the caller is checking "does this
/// reference actually resolve to a T" for a caller-supplied reference that
/// could legitimately be any type -- wrong (keep using `?` directly) when
/// the reference is expected to always be a T by construction.
pub fn decode_or<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(record: &Record) -> Option<T> {
    match record.entry().to_app_option::<T>() {
        Ok(Some(v)) => Some(v),
        _ => None,
    }
}

/// `resolve_latest` followed by "decode it as a T, or fail with a clear
/// message naming what was expected" -- the single most duplicated idiom
/// across every coordinator in this codebase (20+ near-identical call
/// sites before this existed, one per entry type per zome). Returns the
/// record alongside T, since most callers need the record's own action
/// hash for a follow-up link/update, not just the decoded value.
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

/// Walks a set of links to their target records' *current* state (via
/// `resolve_latest`, not a literal `get`), silently skipping any link
/// whose target isn't an `ActionHash` or whose target record can no longer
/// be resolved -- best-effort, don't fail an entire list read over one bad
/// link. The same loop duplicated across every link-anchor-based list
/// extern in this codebase (nearby merchants, menu items, bids, open
/// orders, ...).
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

/// A zome's own `EntryTypes` enum (generated by `hdk_entry_defs`) knows how
/// to resolve itself to the `(ScopedEntryDefIndex, EntryVisibility)` pair a
/// local chain `query()` filter needs -- this just does that resolution
/// once, generically, instead of every `list_my_*` extern across every
/// coordinator reimplementing the identical two-line dance against a
/// throwaway dummy entry value.
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
