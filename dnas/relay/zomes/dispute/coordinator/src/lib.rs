//! Coordinator zome for dispute cases: opening one (called cross-zome from
//! `dispatch::raise_dispute`, never expected to be called directly by a
//! client), an arbitrator submitting a resolution, and the read-side
//! queries `dispatch::apply_dispute_resolution` and arbitrators depend on.
//! See `dispute_integrity` for the actual enforcement -- this crate's own
//! checks are conveniences, not the source of truth.

use dispute_integrity::*;
use hdi::hash_path::path::{Path, TypedPath};
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, next_page_cursor, resolve_latest, resolve_latest_decoded};

fn open_dispute_anchor_path() -> ExternResult<TypedPath> {
    Path::from("open_disputes").typed(LinkTypes::OpenDisputeAnchor)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct OpenDisputeInput {
    pub order_ref: ActionHash,
    pub respondent: AgentPubKey,
    pub reason: DisputeReason,
    pub description: String,
    pub evidence_refs: Vec<ActionHash>,
}

/// Called cross-zome (same agent context, so `agent_info()` here resolves
/// to whoever is actually raising the dispute) from
/// `dispatch::raise_dispute`, which derives `respondent` from the order's
/// real parties before calling this -- `dispute_integrity::validate`
/// re-derives and checks that independently, so this isn't the enforcement,
/// just the write path.
#[hdk_extern]
pub fn open_dispute(input: OpenDisputeInput) -> ExternResult<Record> {
    let raised_by = agent_info()?.agent_initial_pubkey;
    let dispute = Dispute {
        order_ref: input.order_ref.clone(),
        raised_by,
        respondent: input.respondent,
        reason: input.reason,
        description: input.description,
        evidence_refs: input.evidence_refs,
        status: DisputeStatus::Open,
        outcome: None,
        arbitrator: None,
        reasoning: None,
        raised_at: sys_time()?,
        resolved_at: None,
    };
    let action_hash = create_entry(&EntryTypes::Dispute(dispute))?;
    create_link(input.order_ref, action_hash.clone(), LinkTypes::OrderToDispute, ())?;
    let path = open_dispute_anchor_path()?;
    path.ensure()?;
    create_link(path.path_entry_hash()?, action_hash.clone(), LinkTypes::OpenDisputeAnchor, ())?;
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back dispute".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SubmitResolutionInput {
    pub dispute_original_action: ActionHash,
    pub outcome: DisputeOutcome,
    pub reasoning: String,
}

/// Called by an arbitrator (an agent on the DNA's arbitrator roster --
/// `dispute_integrity::validate` rejects this update otherwise). Records
/// the ruling; `dispatch::apply_dispute_resolution` is the separate,
/// subsequent call that actually applies its consequences (payment,
/// forfeiture, reputation) and flips the order's own status.
#[hdk_extern]
pub fn submit_resolution(input: SubmitResolutionInput) -> ExternResult<Record> {
    let (record, mut dispute): (_, Dispute) = resolve_latest_decoded(input.dispute_original_action, "Dispute")?;
    let arbitrator = agent_info()?.agent_initial_pubkey;
    dispute.status = DisputeStatus::Resolved;
    dispute.outcome = Some(input.outcome);
    dispute.arbitrator = Some(arbitrator);
    dispute.reasoning = Some(input.reasoning);
    dispute.resolved_at = Some(sys_time()?);
    let updated = update_entry(record.action_address().clone(), &EntryTypes::Dispute(dispute))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back resolved dispute".into())))
}

#[hdk_extern]
pub fn get_dispute(dispute_original_action: ActionHash) -> ExternResult<Record> {
    resolve_latest(dispute_original_action)
}

#[hdk_extern]
pub fn get_dispute_for_order(order_ref: ActionHash) -> ExternResult<Option<Record>> {
    let links = get_links(LinkQuery::try_new(order_ref, LinkTypes::OrderToDispute)?, GetStrategy::default())?;
    let Some(link) = links.into_iter().next() else { return Ok(None) };
    let Some(action_hash) = link.target.into_action_hash() else { return Ok(None) };
    Ok(Some(resolve_latest(action_hash)?))
}

const DISPUTE_PAGE_SIZE: usize = 50;

#[derive(Serialize, Deserialize, Debug)]
pub struct ListOpenDisputesInput {
    /// Page cursor -- pass back the previous call's `next_after` to continue.
    /// `None` starts from the beginning.
    pub after: Option<Timestamp>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct OpenDisputesPage {
    pub disputes: Vec<Record>,
    pub next_after: Option<Timestamp>,
}

/// For arbitrators to browse what needs review. Not geo-scoped (unlike
/// `dispatch`'s open-order anchor) -- arbitration is low-frequency, not
/// latency-sensitive, so a single global anchor is enough. Paginated
/// (architecture plan §9.3) since disputes, once raised, stay linked here
/// forever (durable case history an arbitrator might want to browse, not
/// noise to prune) -- same reasoning as catalog's pagination, not
/// presence/open-order's time-bucketing. The status filter runs *after*
/// paging, so a page can legitimately return fewer than
/// `DISPUTE_PAGE_SIZE` open disputes if some in that page have since
/// resolved -- request the next page via `next_after` rather than assuming
/// a short page means there's nothing more.
#[hdk_extern]
pub fn list_open_disputes(input: ListOpenDisputesInput) -> ExternResult<OpenDisputesPage> {
    let path = open_dispute_anchor_path()?;
    let mut query = LinkQuery::try_new(path.path_entry_hash()?, LinkTypes::OpenDisputeAnchor)?;
    query.after = input.after;
    let mut links = get_links(query, GetStrategy::default())?;
    links.sort_by_key(|l| l.timestamp);
    let next_after = if links.len() > DISPUTE_PAGE_SIZE { Some(next_page_cursor(links[DISPUTE_PAGE_SIZE - 1].timestamp)) } else { None };
    links.truncate(DISPUTE_PAGE_SIZE);
    let mut disputes = Vec::new();
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        let Ok(record) = resolve_latest(action_hash) else { continue };
        // decode_or, not `?` -- a single malformed/wrong-type entry here
        // must not abort this whole paginated read for every arbitrator;
        // it should just be skipped, same as the two guards right above it.
        let Some(dispute): Option<Dispute> = decode_or(&record) else { continue };
        if dispute.status == DisputeStatus::Open {
            disputes.push(record);
        }
    }
    Ok(OpenDisputesPage { disputes, next_after })
}
