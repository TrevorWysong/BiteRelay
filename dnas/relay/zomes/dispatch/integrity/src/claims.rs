//! A delivery customer's claim that their order never arrived, and what it
//! takes for one to count.

use super::*;

/// Walks an action backward to the `Create` action that started its entry's
/// update chain -- an order's identity, which legs, holds and claims all
/// name. Via `must_get_valid_record`, since integrity zomes can't call
/// coordinator-side hdk functions.
pub(crate) fn resolve_original_creation(action_hash: ActionHash) -> ExternResult<ActionHash> {
    let record = must_get_valid_record(action_hash.clone())?;
    match &record.action().data {
        ActionData::Update(update) => resolve_original_creation(update.original_action_address.clone()),
        _ => Ok(action_hash),
    }
}

/// Whether `author` wrote an update of `order` (a delivery, by its original
/// action) on their own chain, between `chain_top` and the order's
/// placement, for which `matches` holds. An order's history can branch, so
/// someone's decisions on one branch must still bind them on another: this
/// is how validation sees them.
pub(crate) fn wrote_update_of(author: &AgentPubKey, chain_top: &ActionHash, order: &ActionHash, matches: impl Fn(&DeliveryOrder) -> bool) -> ExternResult<bool> {
    let placed = must_get_action(order.clone())?.hashed.content.header.timestamp;
    if must_get_action(chain_top.clone())?.hashed.content.header.timestamp < placed {
        return Ok(false);
    }
    for item in must_get_agent_activity(author.clone(), ChainFilter::until_timestamp(chain_top.clone(), placed).include_cached_entries())? {
        let ActionData::Update(update) = &item.action.hashed.content.data else { continue };
        let entry = match item.cached_entry {
            Some(entry) => entry,
            None => must_get_entry(update.entry_hash.clone())?.content,
        };
        let Entry::App(bytes) = entry else { continue };
        let Ok(version) = DeliveryOrder::try_from(SerializedBytes::from(bytes)) else { continue };
        if matches(&version) && &resolve_original_creation(item.action.hashed.hash.clone())? == order {
            return Ok(true);
        }
    }
    Ok(false)
}
