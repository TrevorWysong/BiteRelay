//! Where an account's ledger stood at a point in its history -- what an
//! issuer reissues when the account is recovered (its key lost), or carries
//! to the next network when it migrates.

use crate::{guest, latest_balance};
use hdk::prelude::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct StandingInput {
    pub agent: AgentPubKey,
    /// An action on `agent`'s chain.
    pub head: ActionHash,
}

/// Where an account's ledger stood as of an action on its chain.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Standing {
    pub balance: i64,
}

/// An account's ledger as of `head`, whatever happened on it after.
#[hdk_extern]
pub fn standing_at(input: StandingInput) -> ExternResult<Standing> {
    let head = get(input.head.clone(), GetOptions::default())?.ok_or(guest("That point in the account's history isn't reachable yet."))?;
    if head.action().author() != &input.agent {
        return Err(guest("That isn't on this account's chain."));
    }
    // Validation ties each entry to the one before it, so the newest at or
    // before `head` says it all.
    Ok(Standing { balance: latest_balance(&input.agent, &input.head)? })
}
