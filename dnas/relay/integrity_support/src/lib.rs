//! Shared building blocks for validation in every integrity zome.
//!
//! **Every op, not just one.** Holochain validates each action as several
//! ops, each at a different authority: the record (what `must_get_valid_record`
//! and `get` by action hash serve), the entry, the update or delete as
//! registered at the original (what an original's `updates` and `deletes`
//! list), the link at its base, and the agent's activity. An authority only
//! knows what its own op's validation said -- so a rule applied to one op
//! type and not another holds only at some authorities, and a peer running a
//! modified conductor (which skips validating its own writes) can publish an
//! action every other authority accepts. `classify` folds every op that
//! carries the same action into one shape, so each zome's rules run at every
//! authority alike.
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

pub mod beacon;
pub mod chain;
pub mod limits;
pub mod versions;
mod sealed;
pub use sealed::{max_sealed_image_bytes, sealed_chunks_problem, sealed_problem, SealedChunks};

/// The record a link points at -- `None` if it points at anything else.
/// Every link in this app indexes a record (by its action); anchors are
/// computed hashes, never trees of links, so a link to anything else is
/// clutter, and every validator refuses it.
pub fn linked_record(target: &AnyLinkableHash) -> ExternResult<Option<Record>> {
    match target.clone().into_action_hash() {
        Some(action) => Ok(Some(must_get_valid_record(action)?)),
        None => Ok(None),
    }
}

/// Decodes `record`'s entry as `T`; `None` for any other entry type
/// (including a failed decode, which is how a wrong type usually shows up).
/// Unlike `RecordEntry::to_app_option`, this also decodes countersigned
/// entries (none in this app today), which it would silently report as
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

/// What an op is about, whichever authority is validating it.
pub enum Checked<ET, LT> {
    /// A new app entry: at its record, its entry and its agent's activity.
    Create { entry: ET, action: TypedAction<CreateData> },
    /// An update of an app entry: at its record, its entry, and at the
    /// original as a registered update.
    Update { entry: ET, action: TypedAction<UpdateData> },
    /// A deleted entry: at its record and at the deleted original.
    Delete { action: TypedAction<DeleteData> },
    CreateLink { link_type: LT, action: TypedAction<CreateLinkData> },
    /// A deleted link, with the link it deletes.
    DeleteLink { link_type: LT, original: TypedAction<CreateLinkData>, action: TypedAction<DeleteLinkData> },
    /// Anything else: chain structure, capability grants, agent keys --
    /// nothing app rules apply to.
    Other,
}

/// Folds every op carrying the same action into one [`Checked`].
pub fn classify<ET, LT>(op: FlatOp<ET, LT>) -> ExternResult<Checked<ET, LT>>
where
    ET: UnitEnum,
    LT: LinkTypesHelper,
    WasmError: From<<LT as LinkTypesHelper>::Error>,
{
    Ok(match op {
        FlatOp::CreateRecord(OpRecord::CreateEntry { app_entry, action }) | FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, action }) => Checked::Create { entry: app_entry, action },
        FlatOp::CreateRecord(OpRecord::UpdateEntry { app_entry, action })
        | FlatOp::CreateEntry(OpEntry::UpdateEntry { app_entry, action })
        | FlatOp::Update(OpUpdate::Entry { app_entry, action }) => Checked::Update { entry: app_entry, action },
        FlatOp::CreateRecord(OpRecord::DeleteEntry { action }) | FlatOp::Delete(OpDelete { action }) => Checked::Delete { action },
        FlatOp::CreateRecord(OpRecord::CreateLink { link_type, action }) | FlatOp::Link(OpLink::CreateLink { link_type, action }) => Checked::CreateLink { link_type, action },
        FlatOp::Link(OpLink::DeleteLink { original_action, link_type, action }) => Checked::DeleteLink { link_type, original: original_action, action },
        // At its record, a deleted link arrives without the link it deletes.
        FlatOp::CreateRecord(OpRecord::DeleteLink { action }) => {
            let created = must_get_action(action.data.link_add_address.clone())?;
            let content = &created.hashed.content;
            let ActionData::CreateLink(data) = &content.data else {
                return Err(wasm_error!(WasmErrorInner::Guest("a deleted link must delete a link".into())));
            };
            let Some(link_type) = LT::from_type(*data.zome_index, *data.link_type)? else {
                return Err(wasm_error!(WasmErrorInner::Guest("that link belongs to another zome".into())));
            };
            Checked::DeleteLink { link_type, original: TypedAction { header: content.header.clone(), data: data.clone() }, action }
        }
        _ => Checked::Other,
    })
}

/// Why `uri` isn't an acceptable image, if it isn't. An image is empty or an
/// inline `data:` URI of a raster format, never a link: a link would have
/// every viewer's app fetch it from a server that learns who they are and
/// what they looked at, and an SVG can carry script.
pub fn image_problem(uri: &str) -> Option<&'static str> {
    if uri.is_empty() {
        return None;
    }
    // An entry is stored by every authority for it, forever -- so the
    // network bounds it (`relay_governance::max_image_bytes`); the app's
    // uploader resizes to fit.
    if uri.len() > relay_governance::max_image_bytes() {
        return Some("an image is larger than this network allows");
    }
    let raster = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,"];
    let Some(payload) = raster.iter().find_map(|prefix| uri.strip_prefix(prefix)) else {
        return Some("an image must be an inline PNG, JPEG, WebP or GIF");
    };
    if !payload.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=') {
        return Some("an image's data must be base64");
    }
    None
}

/// Why an amount is out of bounds, if it is: more than any single amount
/// may be (`limits::MAX_AMOUNT`).
pub fn amount_problem(field: &'static str, amount: u64) -> Option<String> {
    (amount > limits::MAX_AMOUNT).then(|| format!("{field} is more than any amount may be"))
}

/// Why a piece of text is unacceptable, if it is: longer than `max_chars`
/// characters. Every free-text field has a bound, so no entry can grow
/// without limit.
pub fn text_problem(field: &'static str, text: &str, max_chars: usize) -> Option<String> {
    (text.chars().count() > max_chars).then(|| format!("{field} may be at most {max_chars} characters"))
}

/// The first problem among `checks`, as an invalid result.
pub fn first_problem(checks: impl IntoIterator<Item = Option<String>>) -> Option<ValidateCallbackResult> {
    checks.into_iter().flatten().next().map(ValidateCallbackResult::Invalid)
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
