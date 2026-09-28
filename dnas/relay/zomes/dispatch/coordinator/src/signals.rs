//! The zome-call capability grant and the local/remote signal types that
//! Layer 2 of the matching mechanism (see plan §3) is built on. Everything
//! else in this crate sends `RemoteSignal`s; this module is just where the
//! wire format and the receiving end live.

use hdk::prelude::*;
use std::collections::HashSet;

/// `send_remote_signal` reaches `recv_remote_signal` via an actual network
/// zome call to the receiving agent, which Holochain rejects by default
/// unless that function has an explicit capability grant -- this is easy to
/// miss since `send_remote_signal` is fire-and-forget and won't surface the
/// rejection as an error on the sending side.
#[hdk_extern]
pub fn init() -> ExternResult<InitCallbackResult> {
    create_cap_grant(CapGrantEntry::new(
        "recv_remote_signal".into(),
        CapAccess::Unrestricted,
        GrantedFunctions::Listed(HashSet::from([(zome_info()?.name, "recv_remote_signal".into())])),
    ))?;
    Ok(InitCallbackResult::Pass)
}

/// Local UI-facing signals, emitted from `recv_remote_signal` once a remote
/// signal has been handled.
#[derive(Serialize, Deserialize, Debug)]
pub enum LocalSignal {
    NewOrderNearby(ActionHash),
    BidPlaced(ActionHash),
    BidAccepted(ActionHash),
    BidReleased(ActionHash),
}

/// Peer-to-peer signals -- Layer 2 of the matching mechanism. Every receiver
/// list passed to `send_remote_signal` comes from a prior Layer-1 anchor
/// lookup (`get_nearby_providers`) or the order's own requester/bidder; this
/// never broadcasts to an unresolved audience, matching `send_remote_signal`'s
/// requirement of already-known AgentPubKeys.
#[derive(Serialize, Deserialize, Debug)]
pub enum RemoteSignal {
    NewOrderPosted { order_hash: ActionHash },
    BidPlaced { order_hash: ActionHash, bid_hash: ActionHash },
    BidAccepted { bid_hash: ActionHash },
    BidReleased { bid_hash: ActionHash },
}

#[hdk_extern]
pub fn recv_remote_signal(payload: RemoteSignal) -> ExternResult<()> {
    match payload {
        RemoteSignal::NewOrderPosted { order_hash } => emit_signal(LocalSignal::NewOrderNearby(order_hash)),
        RemoteSignal::BidPlaced { bid_hash, .. } => emit_signal(LocalSignal::BidPlaced(bid_hash)),
        RemoteSignal::BidAccepted { bid_hash } => emit_signal(LocalSignal::BidAccepted(bid_hash)),
        RemoteSignal::BidReleased { bid_hash } => emit_signal(LocalSignal::BidReleased(bid_hash)),
    }
}
