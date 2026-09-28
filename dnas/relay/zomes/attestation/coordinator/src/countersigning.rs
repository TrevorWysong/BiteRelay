//! The countersigning session itself: the capability grant that lets the
//! two remote-callable functions below be reached at all, the preflight
//! exchange, and the dual commit. `legs.rs` is where the plain (non-
//! countersigned) `Leg` entry and the various read-side queries live.

use attestation_integrity::*;
use hdk::prelude::*;
use std::collections::HashSet;

/// How long a countersigning session stays open before it must be
/// abandoned. Flagged in the architecture plan as one of the trickier
/// corners of the HDK -- session timeout/abandonment handling below is a
/// first pass, not a hardened implementation.
const SESSION_TIMEOUT_MILLIS: u64 = 60_000;

/// `call_remote` reaches these two functions via a real network zome call,
/// which Holochain rejects by default without an explicit capability grant
/// -- same requirement as `recv_remote_signal` in `dispatch`.
#[hdk_extern]
pub fn init() -> ExternResult<InitCallbackResult> {
    let zome = zome_info()?.name;
    create_cap_grant(CapGrantEntry::new(
        "attestation_remote_calls".into(),
        CapAccess::Unrestricted,
        GrantedFunctions::Listed(HashSet::from([
            (zome.clone(), "accept_leg_attestation_preflight".into()),
            (zome, "commit_countersigned_receipt".into()),
        ])),
    ))?;
    Ok(InitCallbackResult::Pass)
}

pub(crate) fn entry_def_parts(entry: &EntryTypes) -> ExternResult<(ScopedEntryDefIndex, EntryVisibility)> {
    let scoped: ScopedEntryDefIndex = entry.try_into().map_err(|e: WasmError| e)?;
    let visibility = EntryVisibility::from(entry);
    Ok((scoped, visibility))
}

/// Remote-callable: the counterparty accepts the preflight request. Both
/// sides call the underlying `accept_countersigning_preflight_request` --
/// this just exposes it across the network boundary.
#[hdk_extern]
pub fn accept_leg_attestation_preflight(request: PreflightRequest) -> ExternResult<PreflightRequestAcceptance> {
    accept_countersigning_preflight_request(request)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CommitReceiptInput {
    pub leg: ActionHash,
    pub attested_at: Timestamp,
    pub session_data: CounterSigningSessionData,
}

/// Builds the countersigned `Entry::CounterSign` and commits it to the
/// caller's own chain. Called locally by the session initiator for their own
/// commit, and remotely on the counterparty so both chains end up holding
/// the identical countersigned entry -- that dual commit is what makes the
/// attestation a real proof rather than a self-reported claim.
///
/// Deliberately does *only* the countersigned create and nothing else --
/// Holochain's source chain manager requires a countersigning write to be
/// the sole action in its flush (`SourceChainError::DirtyCounterSigningWrite`
/// otherwise); bundling a `create_link` here for the leg->receipt index, as
/// an earlier version of this did, tripped exactly that check on the
/// non-initiating party's side. The link is created separately, once, by the
/// initiator after both commits succeed (see `initiate_leg_attestation`) --
/// a single link is enough for DHT-wide discoverability via `get_links`.
#[hdk_extern]
pub fn commit_countersigned_receipt(input: CommitReceiptInput) -> ExternResult<ActionHash> {
    let receipt = ReceiptAttestation { leg: input.leg.clone(), attested_at: input.attested_at };
    let entry_types = EntryTypes::ReceiptAttestation(receipt);
    let (ScopedEntryDefIndex { zome_index, zome_type }, visibility) = entry_def_parts(&entry_types)?;

    let plain_entry: Entry = entry_types.try_into().map_err(|e: WasmError| e)?;
    let Entry::App(app_entry_bytes) = plain_entry else {
        return Err(wasm_error!(WasmErrorInner::Guest("ReceiptAttestation did not serialize to an App entry".into())));
    };
    let countersigned_entry = Entry::CounterSign(Box::new(input.session_data), app_entry_bytes);
    let create_input = CreateInput::new(
        EntryDefLocation::app(zome_index, zome_type),
        visibility,
        countersigned_entry,
        ChainTopOrdering::Strict,
    );
    let action_hash = create(create_input)?;
    Ok(action_hash)
}

/// Orchestrates a full countersigning session between a leg's two parties:
/// both preflight-accept, then both commit the identical entry to their own
/// chains. This is the session-initiator's entry point -- either party on
/// the leg may call it once the handoff has actually happened.
///
/// Uses an *enzymatic* session (`leg.from` as the designated authority,
/// see `PreflightRequest::try_new`'s `enzymatic` argument below) rather than
/// a plain multi-signer session. Root-caused via
/// `tests/tryorama/src/attestation.test.ts`: a non-enzymatic session's
/// finalization depends on some peer currently holding DHT-basis authority
/// over the entry hash to gather both signed actions and return a signature
/// bundle -- on a small/fresh network that authority resolution can fail to
/// complete before the session times out, so the trial commit succeeds on
/// both sides but neither chain ever durably keeps the entry. Enzymatic mode
/// has both parties push their signed action directly to the known enzyme
/// agent instead, sidestepping DHT-authority resolution entirely -- with it,
/// the test confirms durable finalization on both chains, resolving on the
/// first retry (near-instant), not after any timeout.
#[hdk_extern]
pub fn initiate_leg_attestation(leg_action: ActionHash) -> ExternResult<Record> {
    let leg_record = get(leg_action.clone(), GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("leg not found".into())))?;
    let leg: Leg = leg_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a Leg".into())))?;

    let me = agent_info()?.agent_initial_pubkey;
    let counterparty = if me == leg.from {
        leg.to.clone()
    } else if me == leg.to {
        leg.from.clone()
    } else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "only one of the leg's two parties may initiate its attestation".into()
        )));
    };

    let attested_at = sys_time()?;
    let receipt = ReceiptAttestation { leg: leg_action.clone(), attested_at };
    let entry_types = EntryTypes::ReceiptAttestation(receipt);
    let app_entry_hash = hash_entry(&entry_types)?;
    let (ScopedEntryDefIndex { zome_index, zome_type }, visibility) = entry_def_parts(&entry_types)?;

    // Canonical agent order (leg.from, leg.to) regardless of who initiates,
    // since every signer must agree on byte-identical PreflightRequest and
    // CounterSigningSessionData.responses must line up with signing_agents order.
    let signing_agents: CounterSigningAgents = vec![(leg.from.clone(), vec![]), (leg.to.clone(), vec![])];
    let session_times = session_times_from_millis(SESSION_TIMEOUT_MILLIS)?;
    let action_base = ActionBase::Create(CreateBase::new(EntryType::App(AppEntryDef::new(
        zome_type,
        zome_index,
        visibility,
    ))));
    // Enzymatic: true -- the first signing agent (leg.from) acts as a
    // designated authority that both parties push their signed action to
    // directly over the network, instead of relying on whichever peer
    // happens to hold DHT-basis authority for this hash. Non-enzymatic
    // sessions depend on that authority resolution completing before the
    // session timeout, which this app's own isolated spike found does not
    // reliably happen on a small/fresh network -- see the doc comment on
    // this function.
    let request = PreflightRequest::try_new(
        app_entry_hash,
        signing_agents,
        vec![],
        0,
        true,
        session_times,
        action_base,
        PreflightBytes(vec![]),
    )
    .map_err(|e| wasm_error!(WasmErrorInner::Guest(e.to_string())))?;

    let my_acceptance = accept_countersigning_preflight_request(request.clone())?;
    let PreflightRequestAcceptance::Accepted(my_response) = my_acceptance else {
        return Err(wasm_error!(WasmErrorInner::Guest(format!(
            "local preflight acceptance failed: {:?}",
            my_acceptance
        ))));
    };

    let remote_response = call_remote(
        counterparty,
        "attestation",
        "accept_leg_attestation_preflight".into(),
        None,
        request.clone(),
    )?;
    let ZomeCallResponse::Ok(extern_io) = remote_response else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "counterparty did not accept the attestation preflight".into()
        )));
    };
    let their_acceptance: PreflightRequestAcceptance = extern_io.decode().map_err(|e| wasm_error!(e))?;
    let PreflightRequestAcceptance::Accepted(their_response) = their_acceptance else {
        return Err(wasm_error!(WasmErrorInner::Guest(format!(
            "counterparty rejected the attestation preflight: {:?}",
            their_acceptance
        ))));
    };

    // Order responses to match signing_agents (leg.from, leg.to), not the
    // order they happened to arrive in.
    let (from_response, to_response) = if me == leg.from {
        (my_response, their_response)
    } else {
        (their_response, my_response)
    };
    let session_data = CounterSigningSessionData::try_from_responses(
        vec![from_response, to_response],
        vec![],
    )
    .map_err(|e| wasm_error!(WasmErrorInner::Guest(e.to_string())))?;

    let my_action_hash = commit_countersigned_receipt(CommitReceiptInput {
        leg: leg_action.clone(),
        attested_at,
        session_data: session_data.clone(),
    })?;

    let counterparty_for_commit = if me == leg.from { leg.to } else { leg.from };
    let remote_commit = call_remote(
        counterparty_for_commit,
        "attestation",
        "commit_countersigned_receipt".into(),
        None,
        CommitReceiptInput { leg: leg_action.clone(), attested_at, session_data },
    )?;
    if !matches!(remote_commit, ZomeCallResponse::Ok(_)) {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "counterparty failed to commit their side of the countersigned receipt".into()
        )));
    }

    get(my_action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back committed receipt".into())))
}
