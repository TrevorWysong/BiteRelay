//! Whether someone's account has moved on to a new key -- recovered after
//! their device was lost. A key whose account moved on may
//! be in someone else's hands (a lost phone found), so a store doesn't take
//! its orders and a customer doesn't take its bids: the person carries on
//! from their new key. Asked of the account zome.

use hdk::prelude::*;
use handshake_coordinator_support::guest;

/// Whether `agent`'s account has moved on to a new key. An unreachable
/// account zome says it hasn't: trade isn't blocked on it.
pub(crate) fn has_moved(agent: &AgentPubKey) -> ExternResult<bool> {
    #[derive(Deserialize, Debug)]
    struct Moved {}
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "account", "successions_of".into(), None, agent.clone())? else { return Ok(false) };
    let successions: Vec<Moved> = io.decode().map_err(|e| wasm_error!(e))?;
    Ok(!successions.is_empty())
}

/// Refuses to deal with `agent` if their account has moved on; `who` names
/// them in the refusal ("This customer", "That driver").
pub(crate) fn ensure_not_moved(agent: &AgentPubKey, who: &str) -> ExternResult<()> {
    if has_moved(agent)? {
        return Err(guest(format!("{who}'s account has moved to a new device, so this key can't be used any more.")));
    }
    Ok(())
}
