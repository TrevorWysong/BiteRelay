//! A store's choice groups ("Size", "Milk", "Choose a side") -- shared by
//! the items that list them, as on DoorDash and Uber Eats (see
//! `catalog_types::modifiers`).

use crate::{ItemVersion, ItemVersions};
use catalog_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::chain::{my_current_version, my_versions};
use relay_coordinator_support::{decode_or, guest, resolve_latest, resolve_links_to_records_with_original, resolve_version, update_version, written};

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
    written(action_hash)
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
    // Built on the caller's own latest version, which this device always
    // has: building on an older one would fork the group's history.
    let current = match my_current_version(input.original_action.clone())? {
        Some(current) => current,
        None => resolve_version(input.original_action)?,
    };
    let updated = update_version(&current, &EntryTypes::ModifierGroup(input.group), LinkTypes::Version)?;
    written(updated)
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
        return Err(guest(format!("read at most {MAX_GROUPS_PER_READ} choice groups at once")));
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
    group_refs
        .into_iter()
        .map(|group_ref| {
            let versions = my_versions(group_ref.clone())?;
            let name = versions.last().and_then(decode_or::<ModifierGroup>).map(|g| g.name).unwrap_or_default();
            let versions = versions.iter().map(|r| ItemVersion { action: r.action_address().clone(), written_at: r.action().timestamp() }).collect();
            Ok(ItemVersions { item_ref: group_ref, name, versions })
        })
        .collect()
}

