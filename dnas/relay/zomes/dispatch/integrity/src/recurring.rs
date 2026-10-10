//! Recurring order templates ("same order every Monday"): the entry
//! types and their create/update validation.

use super::*;
use relay_integrity_support::limits::{MAX_TEMPLATE_ITEMS, MAX_TIME_ZONE_CHARS, SEAL_CHUNK_BYTES};
use relay_integrity_support::{sealed_chunks_problem, SealedChunks};

/// The most a recurring order's sealed details may hold: a drop-off and two
/// notes fit in two chunks.
const MAX_DETAILS_BYTES: usize = 2 * SEAL_CHUNK_BYTES;

/// How often a `RecurringOrderTemplate` fires. Deliberately just these two
/// shapes -- the literal "same order every Monday" ask, plus daily as the
/// same shape with no weekday. `hour`/`minute` are wall-clock time in the
/// template's `time_zone`, and `weekday` counts from Sunday = 0.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum RecurrenceRule {
    Daily { hour: u8, minute: u8 },
    Weekly { weekday: u8, hour: u8, minute: u8 },
}

/// A customer's own saved "repeat this order" recipe. Deliberately a plain
/// entry with **no DHT link at all** -- nobody but the owner ever needs to
/// discover these, so `list_my_recurring_templates` is a local chain
/// `query()`, the same zero-anchor-growth shape as
/// `attestation::list_my_receipts`, not a `get_links` anchor like
/// `DeliveryOrder` itself needs for matching. The requester's own conductor
/// fires it when `next_run_at` arrives, with no app open, and advances it
/// to the next occurrence (`dispatch::upkeep`).
/// A recurring order's private parts -- only ever stored sealed.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct TemplateDetails {
    pub dropoff: GeoPoint,
    pub dropoff_notes: String,
    pub kitchen_notes: String,
}

#[hdk_entry_helper]
#[derive(Clone)]
pub struct RecurringOrderTemplate {
    pub requester: AgentPubKey,
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    pub item_refs: Vec<ActionHash>,
    /// Where it goes and the notes for it (`TemplateDetails`), sealed to the
    /// requester -- a standing order shouldn't publish a home address.
    pub sealed_details: SealedChunks,
    pub max_delivery_fee: Option<u64>,
    #[serde(default)]
    pub tip_cents: u64,
    #[serde(default)]
    pub dropoff_preference: DropoffPreference,
    #[serde(default)]
    pub promo_code_ref: Option<ActionHash>,
    pub recurrence: RecurrenceRule,
    /// The IANA time zone `recurrence` is in ("America/New_York"), so "9:00
    /// every day" stays 9:00 local across daylight-saving changes. Templates
    /// from before this read as UTC.
    #[serde(default = "utc")]
    pub time_zone: String,
    /// When it next fires: set at creation, and moved forward each time it
    /// fires -- the one field (besides `active`) an update may change, and
    /// only ever forward.
    pub next_run_at: Timestamp,
    pub active: bool,
    pub created_at: Timestamp,
}

fn utc() -> String {
    "UTC".into()
}

pub(crate) fn validate_recurrence(recurrence: &RecurrenceRule) -> Option<&'static str> {
    match recurrence {
        RecurrenceRule::Daily { hour, minute } if *hour > 23 || *minute > 59 => Some("Daily's hour must be 0-23 and minute must be 0-59"),
        RecurrenceRule::Daily { .. } => None,
        RecurrenceRule::Weekly { weekday, hour, minute } if *weekday > 6 || *hour > 23 || *minute > 59 => {
            Some("Weekly's weekday must be 0-6, hour must be 0-23, and minute must be 0-59")
        }
        RecurrenceRule::Weekly { .. } => None,
    }
}

pub(crate) fn validate_new_recurring_template(template: &RecurringOrderTemplate, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if &template.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a recurring order template can only be authored by its own requester".into(),
        ));
    }
    if template.item_refs.is_empty() || template.item_refs.len() > MAX_TEMPLATE_ITEMS {
        return Ok(ValidateCallbackResult::Invalid(format!("a recurring order has between 1 and {MAX_TEMPLATE_ITEMS} items")));
    }
    if let Some(problem) = sealed_chunks_problem("sealed_details", &template.sealed_details, MAX_DETAILS_BYTES) {
        return Ok(ValidateCallbackResult::Invalid(problem));
    }
    if let Some(reason) = validate_recurrence(&template.recurrence) {
        return Ok(ValidateCallbackResult::Invalid(reason.into()));
    }
    if template.time_zone.is_empty() || template.time_zone.len() > MAX_TIME_ZONE_CHARS {
        return Ok(ValidateCallbackResult::Invalid("time_zone must be an IANA zone name".into()));
    }
    if let Some(reason) = check_merchant_owns_catalog(&template.merchant, &template.catalog_ref)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Only `active` and `next_run_at` may change -- the recipe itself
/// (merchant, items, dropoff, ...) is fixed at creation, mirroring
/// `PromoCode`'s "only active may change" immutability pattern, with one
/// addition: `next_run_at` must be allowed to advance too, since that's
/// exactly what firing the template is supposed to do each time.
pub(crate) fn validate_recurring_template_update(
    template: &RecurringOrderTemplate,
    author: &AgentPubKey,
    original_action_hash: &ActionHash,
) -> ExternResult<ValidateCallbackResult> {
    if &template.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a recurring order template can only be updated by its own requester".into(),
        ));
    }
    let prior_record = must_get_valid_record(original_action_hash.clone())?;
    let prior: RecurringOrderTemplate = prior_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "original_action_hash does not point at a RecurringOrderTemplate entry".into()
        )))?;
    let unchanged = prior.requester == template.requester
        && prior.merchant == template.merchant
        && prior.catalog_ref == template.catalog_ref
        && prior.item_refs == template.item_refs
        && prior.sealed_details == template.sealed_details
        && prior.max_delivery_fee == template.max_delivery_fee
        && prior.tip_cents == template.tip_cents
        && prior.dropoff_preference == template.dropoff_preference
        && prior.promo_code_ref == template.promo_code_ref
        && prior.recurrence == template.recurrence
        && prior.time_zone == template.time_zone
        && prior.created_at == template.created_at;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "a recurring order template update may only change active/next_run_at -- every other field must stay the same".into(),
        ));
    }
    if template.next_run_at < prior.next_run_at {
        return Ok(ValidateCallbackResult::Invalid("a recurring order's next_run_at only moves forward".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}
