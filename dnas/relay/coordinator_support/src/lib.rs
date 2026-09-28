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
