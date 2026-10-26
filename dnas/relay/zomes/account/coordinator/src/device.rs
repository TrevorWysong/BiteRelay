//! Moving an account to a new phone keeps its key: the old phone sends the
//! key, sealed, to the new one, which rebuilds the account's chain from the
//! network (Holochain's restore) and carries on as the same account -- same
//! history, stores, balance and orders in hand. See RECOVERY.md.
//!
//! The one thing that must never happen is both phones writing as the
//! account: two chains with the same key fork it, and the network refuses
//! a forked account for good. So the old phone stops for good once it has
//! sent the key, and sends it only when the network already holds
//! everything it wrote -- what the new phone restores from.

use hdk::prelude::*;

/// Whether this device can hand its key to a new phone now.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct MoveReadiness {
    /// This device's latest action, and its place on the chain.
    pub head: ActionHash,
    pub seq: u32,
    /// The latest action the network's authorities for this account hold,
    /// as far as they answered -- none when none did.
    pub seen: Option<u32>,
    /// Whether they hold this device's latest action, cleanly: everything
    /// it wrote is out, so a new phone restoring the account gets all of it.
    pub ready: bool,
}

/// Where the network stands on the caller's chain, against where this
/// device does. Asked of the network only: this device's own copy always
/// agrees with itself.
#[hdk_extern]
pub fn ready_to_move(_: ()) -> ExternResult<MoveReadiness> {
    let info = agent_info()?;
    let (head, seq, _) = info.chain_head;
    let activity = get_agent_activity(info.agent_initial_pubkey, ChainQueryFilter::new(), ActivityRequest::Status, GetOptions::network())?;
    let seen = match &activity.status {
        ChainStatus::Valid(network_head) => Some(network_head.action_seq),
        _ => activity.highest_observed.as_ref().map(|h| h.action_seq),
    };
    let ready = activity.warrants.is_empty() && matches!(&activity.status, ChainStatus::Valid(network_head) if network_head.hash == head);
    Ok(MoveReadiness { head, seq, seen, ready })
}
