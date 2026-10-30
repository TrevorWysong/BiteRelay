//! The zome-call capability grant and the local/remote signal types the
//! bag-claim flow needs -- mirrors `dispatch_coordinator::signals` exactly.
//! `catalog` had no signal mechanism before goodie bags; this is the
//! whole of it, since `confirm_claim` (`bags.rs`) is the only thing in this
//! zome that ever needs to reach a specific already-known agent directly
//! rather than through a link-anchor read.

use hdk::prelude::*;

/// See `dispatch_coordinator::signals::init`'s own doc comment -- same
/// reasoning, same easy-to-miss failure mode if omitted.
#[hdk_extern]
pub fn init() -> ExternResult<InitCallbackResult> {
    prepare_device(())?;
    Ok(InitCallbackResult::Pass)
}

/// See `dispatch_coordinator::signals::prepare_device`.
#[hdk_extern]
pub fn prepare_device(_: ()) -> ExternResult<()> {
    handshake_coordinator_support::ensure_open_calls("recv_remote_signal", &["recv_remote_signal"])?;
    Ok(())
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
        // The customer's conductor places the order that redeems it
        // (`dispatch::claims`) -- woken now rather than at the next sweep.
        RemoteSignal::ClaimConfirmed { claim_hash } => {
            // Anyone can send this. The upkeep it wakes reads every claim
            // from the network and is idempotent, so waking it is harmless
            // -- and the confirmation may simply not have reached us yet.
            let _ = call(CallTargetCell::Local, "dispatch", "schedule_order_upkeep".into(), None, ());
            // The screen is told only of a confirmation it can see: this
            // customer's claim, confirmed by the sender.
            if confirmed_by(&claim_hash, &call_info()?.provenance)? {
                emit_signal(LocalSignal::ClaimConfirmed(claim_hash))?;
            }
            Ok(())
        }
    }
}

/// Whether `claim_hash` is the caller's own claim, confirmed by `sender`.
fn confirmed_by(claim_hash: &ActionHash, sender: &AgentPubKey) -> ExternResult<bool> {
    let me = agent_info()?.agent_initial_pubkey;
    let Some(record) = get(claim_hash.clone(), GetOptions::default())? else { return Ok(false) };
    let claim = handshake_coordinator_support::decode_or::<catalog_integrity::BagClaim>(&record);
    Ok(record.action().author() == sender && claim.is_some_and(|c| c.customer == me && c.status == catalog_integrity::BagClaimStatus::Confirmed))
}
