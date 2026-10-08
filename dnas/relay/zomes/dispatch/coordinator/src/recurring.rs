//! Recurring order templates ("same order every Monday") -- see
//! `RecurringOrderTemplate`'s own doc comment in `dispatch_integrity` for
//! why this needs no DHT link at all, and why firing is entirely
//! client-driven rather than a p2p cron.

use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{resolve_latest, resolve_latest_decoded};
use relay_types::GeoPoint;

#[derive(Serialize, Deserialize, Debug)]
pub struct CreateRecurringTemplateInput {
    pub merchant: AgentPubKey,
    pub catalog_ref: ActionHash,
    pub item_refs: Vec<ActionHash>,
    pub dropoff: GeoPoint,
    pub max_delivery_fee: Option<u64>,
    #[serde(default)]
    pub special_instructions: String,
    #[serde(default)]
    pub tip_cents: u64,
    #[serde(default)]
    pub dropoff_preference: DropoffPreference,
    #[serde(default)]
    pub promo_code_ref: Option<ActionHash>,
    pub recurrence: RecurrenceRule,
    pub next_run_at: Timestamp,
}

#[hdk_extern]
pub fn create_recurring_template(input: CreateRecurringTemplateInput) -> ExternResult<Record> {
    let requester = agent_info()?.agent_initial_pubkey;
    let template = RecurringOrderTemplate {
        requester,
        merchant: input.merchant,
        catalog_ref: input.catalog_ref,
        item_refs: input.item_refs,
        dropoff: input.dropoff,
        max_delivery_fee: input.max_delivery_fee,
        special_instructions: input.special_instructions,
        tip_cents: input.tip_cents,
        dropoff_preference: input.dropoff_preference,
        promo_code_ref: input.promo_code_ref,
        recurrence: input.recurrence,
        next_run_at: input.next_run_at,
        active: true,
        created_at: sys_time()?,
    };
    let action_hash = create_entry(&EntryTypes::RecurringOrderTemplate(template))?;
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back recurring order template".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SetRecurringTemplateActiveInput {
    pub original_action: ActionHash,
    pub active: bool,
}

#[hdk_extern]
pub fn set_recurring_template_active(input: SetRecurringTemplateActiveInput) -> ExternResult<Record> {
    let (record, mut template): (_, RecurringOrderTemplate) = resolve_latest_decoded(input.original_action, "RecurringOrderTemplate")?;
    template.active = input.active;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::RecurringOrderTemplate(template))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back updated recurring order template".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct AdvanceRecurringTemplateInput {
    pub original_action: ActionHash,
    pub next_run_at: Timestamp,
}

/// Called by the requester's own client immediately after it fires an
/// order from this template -- advances the recipe to its next occurrence.
/// The *math* ("what's the next Monday 9am after this one") is entirely
/// the client's job; this entry has no weekday-arithmetic concept of its
/// own, it just stores whatever timestamp the client computed.
#[hdk_extern]
pub fn advance_recurring_template(input: AdvanceRecurringTemplateInput) -> ExternResult<Record> {
    let (record, mut template): (_, RecurringOrderTemplate) = resolve_latest_decoded(input.original_action, "RecurringOrderTemplate")?;
    template.next_run_at = input.next_run_at;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::RecurringOrderTemplate(template))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back advanced recurring order template".into())))
}

/// A template's stable identity (what `advance_recurring_template` and
/// `set_recurring_template_active` take) alongside its latest state.
#[derive(Serialize, Deserialize, Debug)]
pub struct RecurringTemplateView {
    pub original_action: ActionHash,
    pub record: Record,
}

/// Every template the caller has created, at its latest state -- a local
/// chain read. Filtered to creations (one per template; `query` would
/// otherwise return every update as well), each resolved to its latest.
#[hdk_extern]
pub fn list_my_recurring_templates(_: ()) -> ExternResult<Vec<RecurringTemplateView>> {
    let filter = ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::RecurringOrderTemplate)?).action_type(ActionType::Create);
    Ok(query(filter)?
        .into_iter()
        .filter_map(|creation| {
            let original_action = creation.action_address().clone();
            resolve_latest(original_action.clone()).ok().map(|record| RecurringTemplateView { original_action, record })
        })
        .collect())
}
