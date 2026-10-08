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
    // A store pays its delivery-fee shares from its conductor -- see
    // `settlement::settle_store_shares_periodically`.
    schedule("settle_store_shares_periodically")?;
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
    ChatMessage { order_ref: ActionHash, from: AgentPubKey, text: String, sent_at: Timestamp },
    /// See `tracking::send_location_update` -- driver -> requester only.
    LocationUpdate { order_ref: ActionHash, lat: f64, lon: f64, sent_at: Timestamp },
    /// See `pickup::mark_ready_for_pickup` -- merchant -> requester only.
    PickupReady(ActionHash),
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
    /// Sent only to the *other* party of an already-accepted order (see
    /// `chat::send_chat_message`) -- never a broadcast, same
    /// already-known-AgentPubKey requirement as every other signal here.
    ChatMessage { order_hash: ActionHash, from: AgentPubKey, text: String, sent_at: Timestamp },
    /// Sent only to the order's requester (see `tracking::send_location_update`)
    /// -- same already-known-AgentPubKey requirement as every signal here.
    LocationUpdate { order_hash: ActionHash, lat: f64, lon: f64, sent_at: Timestamp },
    /// Sent only to the pickup order's own requester (see
    /// `pickup::mark_ready_for_pickup`) -- same already-known-AgentPubKey
    /// requirement as every signal here.
    PickupReady { order_hash: ActionHash },
    /// Sent by the customer completing a delivery, to its store: the store
    /// owes its share of the delivery fee, which only it can pay.
    StoreShareDue { order_hash: ActionHash },
}

#[hdk_extern]
pub fn recv_remote_signal(payload: RemoteSignal) -> ExternResult<()> {
    match payload {
        RemoteSignal::NewOrderPosted { order_hash } => emit_signal(LocalSignal::NewOrderNearby(order_hash)),
        RemoteSignal::BidPlaced { bid_hash, .. } => emit_signal(LocalSignal::BidPlaced(bid_hash)),
        RemoteSignal::BidAccepted { bid_hash } => emit_signal(LocalSignal::BidAccepted(bid_hash)),
        RemoteSignal::BidReleased { bid_hash } => emit_signal(LocalSignal::BidReleased(bid_hash)),
        RemoteSignal::ChatMessage { order_hash, from, text, sent_at } => {
            emit_signal(LocalSignal::ChatMessage { order_ref: order_hash, from, text, sent_at })
        }
        RemoteSignal::LocationUpdate { order_hash, lat, lon, sent_at } => {
            emit_signal(LocalSignal::LocationUpdate { order_ref: order_hash, lat, lon, sent_at })
        }
        RemoteSignal::PickupReady { order_hash } => emit_signal(LocalSignal::PickupReady(order_hash)),
        // Paid right here by the store's own conductor -- no UI involved.
        // `pay_store_share` only pays for an order that really was
        // delivered from this agent's store, and only once, so a stray or
        // repeated signal costs a read, nothing more.
        // The store's conductor settles it on its own schedule (see
        // `settlement::settle_store_shares_soon`). Scheduling is idempotent,
        // so a stray or repeated signal just triggers a sweep.
        RemoteSignal::StoreShareDue { .. } => schedule("settle_store_shares_soon"),
    }
}
