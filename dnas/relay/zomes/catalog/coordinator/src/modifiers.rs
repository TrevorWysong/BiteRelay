//! A store's choice groups ("Size", "Milk", "Choose a side") -- shared by
//! the items that list them, as on DoorDash and Uber Eats (see
//! `catalog_types::modifiers`).

use crate::{item_versions, ItemVersion, ItemVersions};
use catalog_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, resolve_latest, resolve_links_to_records_with_original};

/// A choice group's stable identity (its original action -- what items and
/// orders name) alongside its latest content.
#[derive(Serialize, Deserialize, Debug)]
pub struct ModifierGroupView {
    pub original_action: ActionHash,
    pub record: Record,
}

#[hdk_extern]
pub fn create_modifier_group(group: ModifierGroup) -> ExternResult<Record> {
    let catalog_ref = group.catalog_ref.clone();
    let action_hash = create_entry(&EntryTypes::ModifierGroup(group))?;
    create_link(catalog_ref, action_hash.clone(), LinkTypes::CatalogToModifierGroup, ())?;
    get(action_hash, GetOptions::local())?.ok_or(wasm_error!(WasmErrorInner::Guest("could not read back the choice group".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateModifierGroupInput {
    pub original_action: ActionHash,
    pub group: ModifierGroup,
}

/// A new version of a choice group -- every item listing it offers the new
/// options and prices from now on; orders already placed keep the version
/// they were priced at.
#[hdk_extern]
pub fn update_modifier_group(input: UpdateModifierGroupInput) -> ExternResult<Record> {
    // Built on the latest version on the caller's own chain: a DHT read can
    // lag the caller's own last edit and fork the group's history.
    let record = match item_versions(&input.original_action, &my_group_records()?).pop() {
        Some(latest) => latest,
        None => resolve_latest(input.original_action)?,
    };
    let updated = update_entry(record.action_address().clone(), &EntryTypes::ModifierGroup(input.group))?;
    get(updated, GetOptions::local())?.ok_or(wasm_error!(WasmErrorInner::Guest("could not read back the choice group".into())))
}

/// Every choice group a store has -- what its owner manages.
#[hdk_extern]
pub fn list_modifier_groups(catalog_ref: ActionHash) -> ExternResult<Vec<ModifierGroupView>> {
    let links = get_links(LinkQuery::try_new(catalog_ref.clone(), LinkTypes::CatalogToModifierGroup)?, GetStrategy::default())?;
    Ok(views(resolve_links_to_records_with_original(links), &catalog_ref))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GetModifierGroupsInput {
    pub catalog_ref: ActionHash,
    /// Groups by original action: an item's, and those its options open.
    pub groups: Vec<ActionHash>,
}

/// Some of a store's choice groups at their latest -- what a customer's
/// item sheet reads: only the groups the item offers, however many the
/// store has. Groups that aren't the store's are left out.
#[hdk_extern]
pub fn get_modifier_groups(input: GetModifierGroupsInput) -> ExternResult<Vec<ModifierGroupView>> {
    if input.groups.len() > MAX_GROUPS_PER_READ {
        return Err(wasm_error!(WasmErrorInner::Guest(format!("read at most {MAX_GROUPS_PER_READ} choice groups at once"))));
    }
    let mut found = Vec::with_capacity(input.groups.len());
    for group in input.groups {
        if let Ok(record) = resolve_latest(group.clone()) {
            found.push((group, record));
        }
    }
    Ok(views(found, &input.catalog_ref))
}

/// An item's groups and every group they can open, nested to the limit.
const MAX_GROUPS_PER_READ: usize = relay_integrity_support::limits::MAX_ITEM_GROUPS * relay_integrity_support::limits::MAX_GROUP_OPTIONS;

fn views(found: Vec<(ActionHash, Record)>, catalog_ref: &ActionHash) -> Vec<ModifierGroupView> {
    found
        .into_iter()
        .filter(|(_, record)| decode_or::<ModifierGroup>(record).is_some_and(|g| &g.catalog_ref == catalog_ref))
        .map(|(original_action, record)| ModifierGroupView { original_action, record })
        .collect()
}

/// Every version of each of the caller's own choice groups, from their
/// source chain -- what a store checks an order's choices against
/// (`dispatch::pricing::outdated_item`), as it does its items' prices. A
/// group the caller didn't write comes back with no versions.
#[hdk_extern]
pub fn get_my_group_versions(group_refs: Vec<ActionHash>) -> ExternResult<Vec<ItemVersions>> {
    let records = my_group_records()?;
    Ok(group_refs
        .into_iter()
        .map(|group_ref| {
            let versions = item_versions(&group_ref, &records);
            let name = versions.last().and_then(decode_or::<ModifierGroup>).map(|g| g.name).unwrap_or_default();
            let versions = versions.iter().map(|r| ItemVersion { action: r.action_address().clone(), written_at: r.action().timestamp() }).collect();
            ItemVersions { item_ref: group_ref, name, versions }
        })
        .collect())
}

/// Every choice group version on the caller's chain, in the order written.
fn my_group_records() -> ExternResult<Vec<Record>> {
    query(ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::ModifierGroup)?).include_entries(true))
}
