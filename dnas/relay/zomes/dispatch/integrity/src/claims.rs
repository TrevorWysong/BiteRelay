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
    for item in relay_integrity_support::chain::activity_since(author, chain_top, placed)? {
        let ActionData::Update(update) = &item.action.hashed.content.data else { continue };
        let Entry::App(bytes) = relay_integrity_support::chain::entry_of(&item, &update.entry_hash)? else { continue };
        let Ok(version) = DeliveryOrder::try_from(SerializedBytes::from(bytes)) else { continue };
        if matches(&version) && &resolve_original_creation(item.action.hashed.hash.clone())? == order {
            return Ok(true);
        }
    }
    Ok(false)
}
