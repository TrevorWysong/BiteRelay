//! Whether someone's account has moved on to a new key -- recovered after
//! their device was lost. A key whose account moved on may
//! be in someone else's hands (a lost phone found), so a store doesn't take
//! its orders and a customer doesn't take its bids: the person carries on
//! from their new key. Asked of the account zome.

use hdk::prelude::*;
use relay_coordinator_support::guest;

/// Refuses to deal with `agent` if their account has moved on; `who` names
/// them in the refusal ("This customer", "That driver").
pub(crate) fn ensure_not_moved(agent: &AgentPubKey, who: &str) -> ExternResult<()> {
    #[derive(Deserialize, Debug)]
    struct Moved {}
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "account", "successions_of".into(), None, agent.clone())? else {
        // Unreachable account zome: don't block trade on it.
        return Ok(());
    };
    let successions: Vec<Moved> = io.decode().map_err(|e| wasm_error!(e))?;
    if successions.is_empty() {
        Ok(())
    } else {
        Err(guest(format!("{who}'s account has moved to a new device, so this key can't be used any more.")))
    }
}
