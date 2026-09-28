//! Coordinator zome for agent identity: `Profile` (roles, display name) and
//! `ProviderCredential` (vehicle/verification, kept separate since it
//! churns independently of identity -- see the integrity crate).

use hdk::prelude::*;
use profiles_integrity::*;
use relay_coordinator_support::resolve_latest;

#[hdk_extern]
pub fn create_profile(profile: Profile) -> ExternResult<Record> {
    let action_hash = create_entry(&EntryTypes::Profile(profile))?;
    let agent = agent_info()?.agent_initial_pubkey;
    create_link(agent, action_hash.clone(), LinkTypes::AgentToProfile, ())?;
    let record = get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back created profile".into())))?;
    Ok(record)
}

#[hdk_extern]
pub fn get_profile_for_agent(agent: AgentPubKey) -> ExternResult<Option<Record>> {
    let links = get_links(
        LinkQuery::try_new(agent, LinkTypes::AgentToProfile)?,
        GetStrategy::default(),
    )?;
    let Some(link) = links.into_iter().max_by_key(|l| l.timestamp) else {
        return Ok(None);
    };
    let action_hash = link
        .target
        .into_action_hash()
        .ok_or(wasm_error!(WasmErrorInner::Guest("malformed profile link target".into())))?;
    resolve_latest(action_hash).map(Some)
}

#[hdk_extern]
pub fn update_profile(input: UpdateProfileInput) -> ExternResult<Record> {
    let current = resolve_latest(input.original_action)?;
    let updated_hash = update_entry(current.action_address().clone(), &EntryTypes::Profile(input.updated_profile))?;
    let record = get(updated_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back updated profile".into())))?;
    Ok(record)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateProfileInput {
    pub original_action: ActionHash,
    pub updated_profile: Profile,
}

#[hdk_extern]
pub fn register_provider_credential(credential: ProviderCredential) -> ExternResult<Record> {
    let profile_action = credential.profile_action.clone();
    let action_hash = create_entry(&EntryTypes::ProviderCredential(credential))?;
    create_link(profile_action, action_hash.clone(), LinkTypes::ProfileToProviderCredential, ())?;
    let record = get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back provider credential".into())))?;
    Ok(record)
}

#[hdk_extern]
pub fn get_provider_credential(action_hash: ActionHash) -> ExternResult<Option<Record>> {
    get(action_hash, GetOptions::local())
}

/// Starts from a driver's Profile action (what every other part of the
/// system actually has on hand -- a bid, an order, a browse listing) rather
/// than requiring the caller to already know the credential's own hash.
#[hdk_extern]
pub fn get_provider_credential_for_profile(profile_action: ActionHash) -> ExternResult<Option<Record>> {
    let links = get_links(
        LinkQuery::try_new(profile_action, LinkTypes::ProfileToProviderCredential)?,
        GetStrategy::default(),
    )?;
    let Some(link) = links.into_iter().max_by_key(|l| l.timestamp) else {
        return Ok(None);
    };
    let action_hash = link
        .target
        .into_action_hash()
        .ok_or(wasm_error!(WasmErrorInner::Guest("malformed provider credential link target".into())))?;
    get(action_hash, GetOptions::default())
}
