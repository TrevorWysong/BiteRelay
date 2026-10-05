//! The zome-call capability grant and the local/remote signal types the
//! bag-claim flow needs -- mirrors `dispatch_coordinator::signals` exactly.
//! `catalog` had no signal mechanism before goodie bags; this is the
//! whole of it, since `confirm_claim` (`bags.rs`) is the only thing in this
//! zome that ever needs to reach a specific already-known agent directly
//! rather than through a link-anchor read.

use hdk::prelude::*;
use std::collections::HashSet;

/// See `dispatch_coordinator::signals::init`'s own doc comment -- same
/// reasoning, same easy-to-miss failure mode if omitted.
#[hdk_extern]
pub fn init() -> ExternResult<InitCallbackResult> {
    create_cap_grant(CapGrantEntry::new(
        "recv_remote_signal".into(),
        CapAccess::Unrestricted,
        GrantedFunctions::Listed(HashSet::from([(zome_info()?.name, "recv_remote_signal".into())])),
    ))?;
    Ok(InitCallbackResult::Pass)
}

/// Local UI-facing signal, emitted from `recv_remote_signal` once a remote
/// signal has been handled.
#[derive(Serialize, Deserialize, Debug)]
pub enum LocalSignal {
    /// See `bags::confirm_claim` -- merchant -> customer only.
    ClaimConfirmed(ActionHash),
}

/// Sent only to the claim's own customer (see `bags::confirm_claim`) --
/// same already-known-AgentPubKey requirement every signal in this
/// codebase has.
#[derive(Serialize, Deserialize, Debug)]
pub enum RemoteSignal {
    ClaimConfirmed { claim_hash: ActionHash },
}

#[hdk_extern]
pub fn recv_remote_signal(payload: RemoteSignal) -> ExternResult<()> {
    match payload {
        RemoteSignal::ClaimConfirmed { claim_hash } => emit_signal(LocalSignal::ClaimConfirmed(claim_hash)),
    }
}
