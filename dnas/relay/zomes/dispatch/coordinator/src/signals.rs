//! The zome-call capability grant, the local/remote signal types that
//! Layer 2 of the matching mechanism (see plan §3) is built on, and
//! `post_commit`, which signals every order change to the order's other
//! parties. This module is where the wire format and both ends live.

use crate::upkeep;
use dispatch_integrity::*;
use relay_coordinator_support::{decode_or, original_action_of, resolve_latest_decoded};
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
    // Tending a customer's waiting orders and answering a store's new ones
    // -- see `upkeep`.
    schedule("tend_orders_periodically")?;
    Ok(InitCallbackResult::Pass)
}

/// Which side of an order a signal's recipient is on.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderRole {
    Customer,
    Store,
    Driver,
}

/// What an order changed to.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum OrderChange {
    Delivery { status: DeliveryStatus, cancellation: Option<Cancellation> },
    Pickup { status: PickupStatus, cancellation: Option<Cancellation> },
}

/// Local UI-facing signals, emitted from `recv_remote_signal` once a remote
/// signal has been handled.
#[derive(Serialize, Deserialize, Debug)]
pub enum LocalSignal {
    /// A new order for one of this agent's stores to accept.
    OrderPlaced(ActionHash),
    /// An order this agent is party to changed -- what it changed to, and
    /// which side of it this agent is on, so the app can say so without
    /// re-reading it.
    OrderUpdated { order_hash: ActionHash, change: OrderChange, role: OrderRole },
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
    /// Sent to a store when an order arrives for it to accept -- its queue
    /// polls too, so this only makes a new order show up at once.
    OrderPlaced { order_hash: ActionHash },
    /// Sent to each of an order's other parties whenever it changes (see
    /// `post_commit`), so their screens refresh and they're told what
    /// happened without polling fast.
    OrderUpdated { order_hash: ActionHash, change: OrderChange, role: OrderRole },
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
        // A store set to auto-accept answers it from its conductor.
        RemoteSignal::OrderPlaced { order_hash } => {
            upkeep::answer_new_orders_soon()?;
            emit_signal(LocalSignal::OrderPlaced(order_hash))
        }
        RemoteSignal::OrderUpdated { order_hash, change, role } => emit_signal(LocalSignal::OrderUpdated { order_hash, change, role }),
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
        // The store's conductor settles it on its own schedule (see
        // `settlement::settle_store_shares_soon`). Scheduling is idempotent,
        // so a stray or repeated signal just triggers a sweep.
        RemoteSignal::StoreShareDue { .. } => schedule("settle_store_shares_soon"),
    }
}

/// After every commit, tells an order's other parties it changed: the store
/// when an order is placed with it (`OrderPlaced`), everyone else on the
/// order otherwise (`OrderUpdated`). One place, so every path that changes
/// an order -- an extern, the conductor's upkeep, a dispute ruling --
/// signals alike. Best-effort, like every signal: screens still poll, just
/// slowly.
#[hdk_extern(infallible)]
pub fn post_commit(committed: Vec<SignedActionHashed>) {
    for action in committed {
        let _ = announce_order_change(&action);
    }
}

fn announce_order_change(action: &SignedActionHashed) -> ExternResult<()> {
    let Some(entry_type) = action.action().entry_type() else { return Ok(()) };
    let is_order = [UnitEntryTypes::DeliveryOrder, UnitEntryTypes::PickupOrder].into_iter().any(|unit| EntryType::try_from(unit).is_ok_and(|t| &t == entry_type));
    if !is_order {
        return Ok(());
    }
    let Some(record) = get(action.as_hash().clone(), GetOptions::local())? else { return Ok(()) };
    let order_hash = original_action_of(action.as_hash().clone())?;
    let (placed, change, parties) = if let Some(order) = decode_or::<DeliveryOrder>(&record) {
        let driver = match &order.accepted_bid {
            Some(bid_ref) => resolve_latest_decoded::<Bid>(bid_ref.clone(), "Bid").ok().map(|(_, bid)| (bid.bidder, OrderRole::Driver)),
            None => None,
        };
        let parties = [Some((order.requester, OrderRole::Customer)), Some((order.merchant, OrderRole::Store)), driver].into_iter().flatten().collect::<Vec<_>>();
        (order.status == DeliveryStatus::Placed, OrderChange::Delivery { status: order.status, cancellation: order.cancellation }, parties)
    } else if let Some(order) = decode_or::<PickupOrder>(&record) {
        let parties = vec![(order.requester, OrderRole::Customer), (order.merchant, OrderRole::Store)];
        (order.status == PickupStatus::Placed, OrderChange::Pickup { status: order.status, cancellation: order.cancellation }, parties)
    } else {
        return Ok(());
    };
    let me = agent_info()?.agent_initial_pubkey;
    let mut told: Vec<AgentPubKey> = Vec::new();
    for (party, role) in parties {
        // Nobody needs telling what they just did themselves -- and someone
        // ordering from their own store hears as the customer, once.
        if party == me || told.contains(&party) {
            continue;
        }
        told.push(party.clone());
        let signal = match role {
            // Only the store has anything to do with a new order: accept it.
            OrderRole::Store if placed => RemoteSignal::OrderPlaced { order_hash: order_hash.clone() },
            _ if placed => continue,
            _ => RemoteSignal::OrderUpdated { order_hash: order_hash.clone(), change: change.clone(), role },
        };
        send_remote_signal(signal, vec![party])?;
    }
    Ok(())
}
