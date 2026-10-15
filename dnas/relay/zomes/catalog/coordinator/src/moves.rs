//! Moving a store to its owner's new key -- after they hand their account
//! to a new phone, or recover it (the account zome). A key can't change
//! another key's entries, so the new key republishes the store as its own:
//! its details, choice groups, menu and live promo codes, every reference
//! between them remapped to the copies. A `StoreSuccession` ties old to
//! new, so its ratings follow it and customers are sent on from the old.
//! The new store starts unlisted: listing it sets aside the network's
//! stake from the new key's balance.

use crate::*;
use std::collections::BTreeMap;

/// How far back a store's line is followed.
const MAX_STORE_LINE: usize = 16;

/// The caller's own `Succession`, as the account zome reports it.
#[derive(Deserialize, Debug)]
struct MySuccession {
    succession: ActionHash,
    predecessor: AgentPubKey,
}

#[derive(Deserialize, Debug)]
struct SuccessionView {
    successor: AgentPubKey,
}

fn guest(message: impl Into<String>) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message.into()))
}

/// The stores `owner` has published, oldest first -- for a new key to see
/// what its predecessor ran.
#[hdk_extern]
pub fn catalogs_of(owner: AgentPubKey) -> ExternResult<Vec<CatalogView>> {
    let mut links = get_links(LinkQuery::try_new(owner.clone(), LinkTypes::OwnerToCatalog)?, GetStrategy::default())?;
    links.sort_by_key(|l| l.timestamp);
    Ok(resolve_links_to_records_with_original(links)
        .into_iter()
        .filter(|(_, record)| record.action().author() == &owner)
        .map(|(original_action, record)| CatalogView { original_action, record })
        .collect())
}

/// Republishes `from` -- a store of the account the caller took over -- as
/// the caller's own, and records the move. Returns the new store's original
/// action. Safe to repeat: a store moved already returns its new one.
#[hdk_extern]
pub fn move_store(from: ActionHash) -> ExternResult<ActionHash> {
    let me = agent_info()?.agent_initial_pubkey;
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "account", "my_succession".into(), None, ())? else {
        return Err(guest("Couldn't read this device's account."));
    };
    let mine: Option<MySuccession> = io.decode().map_err(|e| wasm_error!(e))?;
    let mine = mine.ok_or(guest("This device hasn't taken over an account."))?;
    let moved = query(ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::StoreSuccession)?).include_entries(true))?;
    if let Some(earlier) = moved.iter().filter_map(decode_or::<StoreSuccession>).find(|m| m.from == from) {
        return Ok(earlier.to);
    }
    let (_, store): (_, MerchantCatalog) = resolve_latest_decoded(from.clone(), "MerchantCatalog")?;
    if store.owner != mine.predecessor {
        return Err(guest("That store wasn't this account's."));
    }

    let to = create_entry(&EntryTypes::MerchantCatalog(MerchantCatalog { owner: me.clone(), dietary_tags: Vec::new(), ..store }))?;
    create_link(me, to.clone(), LinkTypes::OwnerToCatalog, ())?;

    let groups = copy_groups(&from, &to)?;
    let items = copy_items(&from, &to, &groups)?;
    recompute_dietary_tags(&to)?;
    copy_promos(&from, &to, &items)?;

    let hash = create_entry(&EntryTypes::StoreSuccession(StoreSuccession { from: from.clone(), to: to.clone(), succession: mine.succession }))?;
    create_link(from, hash.clone(), LinkTypes::CatalogToSuccessor, ())?;
    create_link(to.clone(), hash, LinkTypes::CatalogToPredecessor, ())?;
    Ok(to)
}

/// Copies the store's choice groups, each after the groups its options
/// open, so every copy names copies. Returns old original -> new.
fn copy_groups(from: &ActionHash, to: &ActionHash) -> ExternResult<BTreeMap<ActionHash, ActionHash>> {
    let mut pending: Vec<(ActionHash, ModifierGroup)> = list_modifier_groups(from.clone())?
        .into_iter()
        .filter_map(|view| decode_or::<ModifierGroup>(&view.record).map(|group| (view.original_action, group)))
        .collect();
    let mut copies: BTreeMap<ActionHash, ActionHash> = BTreeMap::new();
    while !pending.is_empty() {
        let before = pending.len();
        let mut waiting = Vec::new();
        for (original, group) in pending {
            let nested: Vec<&ActionHash> = group.options.iter().filter_map(|o| o.nested_group.as_ref()).collect();
            if nested.iter().any(|n| !copies.contains_key(*n)) {
                waiting.push((original, group));
                continue;
            }
            let options = group
                .options
                .iter()
                .map(|option| {
                    let mut option = option.clone();
                    option.nested_group = option.nested_group.map(|n| copies[&n].clone());
                    option
                })
                .collect();
            let copy = create_modifier_group(ModifierGroup { catalog_ref: to.clone(), options, ..group })?;
            copies.insert(original, copy.action_address().clone());
        }
        // Groups that open a group that isn't the store's: left behind, as
        // the store itself couldn't offer them.
        if waiting.len() == before {
            break;
        }
        pending = waiting;
    }
    Ok(copies)
}

/// Copies the menu, each item offering the copies of its groups. Returns
/// old original -> new.
fn copy_items(from: &ActionHash, to: &ActionHash, groups: &BTreeMap<ActionHash, ActionHash>) -> ExternResult<BTreeMap<ActionHash, ActionHash>> {
    let mut copies = BTreeMap::new();
    let mut after = None;
    loop {
        let page = list_menu_items(ListMenuItemsInput { catalog_ref: from.clone(), after })?;
        for view in page.items {
            let Some(item) = decode_or::<MenuItem>(&view.record) else { continue };
            let modifier_groups = item.modifier_groups.iter().filter_map(|g| groups.get(g).cloned()).collect();
            let copy = create_entry(&EntryTypes::MenuItem(MenuItem { catalog_ref: to.clone(), modifier_groups, ..item }))?;
            create_link(to.clone(), copy.clone(), LinkTypes::CatalogToMenuItem, ())?;
            copies.insert(view.original_action, copy);
        }
        match page.next_after {
            Some(next) => after = Some(next),
            None => return Ok(copies),
        }
    }
}

/// Copies the promo codes still live, naming the copies of their items.
fn copy_promos(from: &ActionHash, to: &ActionHash, items: &BTreeMap<ActionHash, ActionHash>) -> ExternResult<()> {
    let now = sys_time()?;
    let remap = |item: &ActionHash| items.get(item).cloned();
    for view in list_live_promo_codes(from.clone())? {
        let Some(promo) = decode_or::<PromoCode>(&view.record) else { continue };
        if !promo.active || promo.expires_at.is_some_and(|at| at <= now) {
            continue;
        }
        let requirement = match promo.requirement {
            PromoRequirement::MinimumItemQuantity { item_ref, quantity } => match remap(&item_ref) {
                Some(item_ref) => PromoRequirement::MinimumItemQuantity { item_ref, quantity },
                None => continue,
            },
            other => other,
        };
        let reward = match promo.reward {
            PromoReward::FreeItem { item_ref, quantity } => match remap(&item_ref) {
                Some(item_ref) => PromoReward::FreeItem { item_ref, quantity },
                None => continue,
            },
            PromoReward::PercentOffItem { item_ref, percent, quantity } => match remap(&item_ref) {
                Some(item_ref) => PromoReward::PercentOffItem { item_ref, percent, quantity },
                None => continue,
            },
            other => other,
        };
        create_promo_code(CreatePromoCodeInput { catalog_ref: to.clone(), code: promo.code, requirement, reward, expires_at: promo.expires_at, auto_apply: promo.auto_apply })?;
    }
    Ok(())
}

/// The moves out of `catalog` that stand: made by a key whose succession of
/// the store's owner still counts (the account zome's `successions_of`
/// leaves out a recovery whose plan was replaced). Newest last.
fn standing_moves(catalog: &ActionHash, link_type: LinkTypes) -> ExternResult<Vec<StoreSuccession>> {
    let mut moves = Vec::new();
    let links = get_links(LinkQuery::try_new(catalog.clone(), link_type)?, GetStrategy::default())?;
    for record in resolve_links_to_records_with_original(links).into_iter().map(|(_, r)| r) {
        let Some(moved) = decode_or::<StoreSuccession>(&record) else { continue };
        let Some(old) = get(moved.from.clone(), GetOptions::default())? else { continue };
        let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "account", "successions_of".into(), None, old.action().author().clone())? else { continue };
        let successions: Vec<SuccessionView> = io.decode().map_err(|e| wasm_error!(e))?;
        if successions.iter().any(|s| &s.successor == record.action().author()) {
            moves.push(moved);
        }
    }
    Ok(moves)
}

/// Where `catalog` moved to, if its owner's new key moved it -- what a
/// customer opening the old store is sent on to.
#[hdk_extern]
pub fn store_successor(catalog: ActionHash) -> ExternResult<Option<ActionHash>> {
    Ok(standing_moves(&catalog, LinkTypes::CatalogToSuccessor)?.pop().map(|m| m.to))
}

/// The stores `catalog` carries on from, newest first -- whose ratings are
/// its own.
#[hdk_extern]
pub fn store_line(catalog: ActionHash) -> ExternResult<Vec<ActionHash>> {
    let mut line: Vec<ActionHash> = Vec::new();
    let mut current = catalog;
    while line.len() < MAX_STORE_LINE {
        let Some(moved) = standing_moves(&current, LinkTypes::CatalogToPredecessor)?.pop() else { break };
        if line.contains(&moved.from) {
            break;
        }
        line.push(moved.from.clone());
        current = moved.from;
    }
    Ok(line)
}

/// Whether the store has moved to a new key -- left out of listings, as its
/// owner carries on from the new one.
pub(crate) fn has_moved(catalog: &ActionHash) -> ExternResult<bool> {
    let links = get_links(LinkQuery::try_new(catalog.clone(), LinkTypes::CatalogToSuccessor)?, GetStrategy::default())?;
    Ok(!links.is_empty() && store_successor(catalog.clone())?.is_some())
}
