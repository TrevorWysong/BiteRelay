//! Shared building blocks for link validation in every integrity zome.
//!
//! A link is only as trustworthy as its validation: without a rule, any
//! agent can attach anything under anyone's base -- e.g. another store's
//! reviews under a competitor, or foreign items in someone's menu -- and
//! every read that walks those links is fooled. The rule every zome applies
//! with these helpers is the same: a link must agree with the entry it
//! points at (its base is where that entry says it belongs) and be authored
//! by the agent who legitimately creates it.

use hdi::hash_path::path::Path;
use hdi::prelude::*;

/// What a link points at. Anchor paths (`Path::ensure`) build their tree
/// out of links whose targets are path *entries*; data links target the
/// *action* of the record they index. Rules apply to data links; tree links
/// only shape an anchor and carry no claim about any record.
pub enum LinkTarget {
    PathNode,
    Record(Record),
}

pub fn link_target(target: &AnyLinkableHash) -> ExternResult<LinkTarget> {
    match target.clone().into_action_hash() {
        Some(action) => Ok(LinkTarget::Record(must_get_valid_record(action)?)),
        None => Ok(LinkTarget::PathNode),
    }
}

/// Decodes `record`'s entry as `T`; `None` for any other entry type
/// (including a failed decode, which is how a wrong type usually shows up).
/// Unlike `RecordEntry::to_app_option`, this also decodes countersigned
/// entries (e.g. receipt attestations), which it would silently report as
/// absent.
pub fn decode<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(record: &Record) -> Option<T> {
    match record.entry().as_option()? {
        Entry::App(bytes) | Entry::CounterSign(_, bytes) => T::try_from(SerializedBytes::from(bytes.to_owned())).ok(),
        _ => None,
    }
}

pub fn path_hash(path: impl Into<String>) -> ExternResult<AnyLinkableHash> {
    Ok(Path::from(path.into()).path_entry_hash()?.into())
}

/// Follows an update chain back to the record's original creation action --
/// for links keyed by an entry's stable identity while the entry itself
/// names a later update.
pub fn original_creation(action_hash: ActionHash) -> ExternResult<ActionHash> {
    let mut current = action_hash;
    loop {
        let record = must_get_valid_record(current.clone())?;
        match &record.action().data {
            ActionData::Update(update) => current = update.original_action_address.clone(),
            _ => return Ok(current),
        }
    }
}

pub fn valid() -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}

pub fn invalid(reason: &str) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(reason.into()))
}

/// `valid()` when `ok`, otherwise `invalid(reason)`.
pub fn require(ok: bool, reason: &str) -> ExternResult<ValidateCallbackResult> {
    if ok {
        valid()
    } else {
        invalid(reason)
    }
}
