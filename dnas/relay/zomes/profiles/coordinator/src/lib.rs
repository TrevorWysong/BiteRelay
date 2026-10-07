//! Coordinator zome for agent identity: `Profile` (roles, display name) and
//! `ProviderCredential` (vehicle/verification, kept separate since it
//! churns independently of identity -- see the integrity crate).

use hdk::prelude::*;
use profiles_integrity::*;
use relay_coordinator_support::{resolve_latest, resolve_links_to_records_with_original};

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

// --- favorite restaurants --- a customer's own saved-restaurant list.
// Personal, zero-multi-party-trust data (nobody else ever needs to query
// "who favorited this catalog") -- so unlike the discovery anchors
// elsewhere in this app, there's no hot-shared-anchor concern here at all:
// the link base is this one agent's own pubkey, and the set it bounds is
// "how many restaurants this one person has favorited," not anything that
// grows with total app usage. No entry type, no pagination -- a personal
// list is realistically dozens of items at most, same bounded-list
// reasoning already applied to a merchant's promo codes.

#[hdk_extern]
pub fn add_favorite(catalog_ref: ActionHash) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    create_link(me, catalog_ref, LinkTypes::AgentToFavorite, ())?;
    Ok(())
}

/// Finds and deletes the specific link for this `catalog_ref` among the
/// caller's own favorite links -- `delete_link` needs the *create* action's
/// own hash, not the target, so this always does a lookup first rather than
/// trusting a client-cached link hash that could be stale.
#[hdk_extern]
pub fn remove_favorite(catalog_ref: ActionHash) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    let links = get_links(LinkQuery::try_new(me, LinkTypes::AgentToFavorite)?, GetStrategy::default())?;
    for link in links {
        if link.target.into_action_hash().as_ref() == Some(&catalog_ref) {
            delete_link(link.create_link_hash, GetOptions::default())?;
        }
    }
    Ok(())
}

#[hdk_extern]
pub fn list_favorites(_: ()) -> ExternResult<Vec<ActionHash>> {
    let me = agent_info()?.agent_initial_pubkey;
    let links = get_links(LinkQuery::try_new(me, LinkTypes::AgentToFavorite)?, GetStrategy::default())?;
    Ok(links.into_iter().filter_map(|l| l.target.into_action_hash()).collect())
}

// --- saved addresses -- a customer's own named address book ("Home",
// "Work", ...), the DoorDash/UberEats-style "deliver to" switcher. See
// `SavedAddress`'s own doc comment for why this lives on-chain rather
// than in `localStorage` the way `location`'s own ephemeral "which one am
// I using right now" pointer does.

#[hdk_extern]
pub fn save_address(address: SavedAddress) -> ExternResult<Record> {
    let me = agent_info()?.agent_initial_pubkey;
    let action_hash = create_entry(&EntryTypes::SavedAddress(address))?;
    create_link(me, action_hash.clone(), LinkTypes::OwnerToSavedAddress, ())?;
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back saved address".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateSavedAddressInput {
    pub original_action: ActionHash,
    pub address: SavedAddress,
}

#[hdk_extern]
pub fn update_saved_address(input: UpdateSavedAddressInput) -> ExternResult<Record> {
    let record = resolve_latest(input.original_action)?;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::SavedAddress(input.address))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back updated saved address".into())))
}

/// Finds and deletes the specific link for this `original_action` among
/// the caller's own saved-address links -- same "always look up the real
/// create-action hash, never trust a client-cached one" reasoning as
/// `remove_favorite`. The entry itself stays on the DHT (nothing on
/// Holochain can truly be erased); this just makes it stop showing up in
/// `list_my_addresses`.
#[hdk_extern]
pub fn delete_saved_address(original_action: ActionHash) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    let links = get_links(LinkQuery::try_new(me, LinkTypes::OwnerToSavedAddress)?, GetStrategy::default())?;
    for link in links {
        if link.target.into_action_hash().as_ref() == Some(&original_action) {
            delete_link(link.create_link_hash, GetOptions::default())?;
        }
    }
    Ok(())
}

/// Pairs each saved address's stable identity with its current content --
/// same shape (and same reason) as catalog's own `CatalogView`: the
/// `OwnerToSavedAddress` link target is fixed forever at `save_address`
/// time, so a caller editing/deleting a saved address later needs that
/// original hash, never whatever a resolved-to-latest `Record`'s own
/// action hash happens to be.
#[derive(Serialize, Deserialize, Debug)]
pub struct SavedAddressView {
    pub original_action: ActionHash,
    pub record: Record,
}

#[hdk_extern]
pub fn list_my_addresses(_: ()) -> ExternResult<Vec<SavedAddressView>> {
    let me = agent_info()?.agent_initial_pubkey;
    let links = get_links(LinkQuery::try_new(me, LinkTypes::OwnerToSavedAddress)?, GetStrategy::default())?;
    Ok(resolve_links_to_records_with_original(links)
        .into_iter()
        .map(|(original_action, record)| SavedAddressView { original_action, record })
        .collect())
}
