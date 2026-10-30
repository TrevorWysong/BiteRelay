//! The zome-call capability grant, the local/remote signal types, and
//! `post_commit`, which signals every order change to the order's other
//! parties. This module is where the wire format and both ends live.
//!
//! **A signal is a claim, not a fact.** `recv_remote_signal` is open to any
//! peer (it must be: signals arrive from whoever is on an order), and a
//! payload says whatever its sender wrote. So every handler checks who
//! actually sent it (`call_info().provenance`, which the conductor verifies)
//! against the order it's about, and anything it tells the user is read from
//! the order itself, never taken from the payload. A signal that doesn't
//! check out is dropped: screens poll, so nothing is lost.
//!
//! A signal that carries nothing but "go and look" (a new order, a new bid,
//! money returned) can outrun the data it's about. Those are dropped only
//! when what this agent can read *contradicts* them -- if the order hasn't
//! arrived yet, the refresh they prompt reads it and checks it like any
//! other read. A signal that carries content (a status to tell the user)
//! is never passed on unverified. Chat and live location don't come
//! through here at all: they're direct signals, app to app (`live`).

use crate::upkeep;
use dispatch_integrity::*;
use relay_coordinator_support::{decode_or, open, original_action_of, resolve_latest, resolve_latest_decoded};
use hdk::prelude::*;

/// `send_remote_signal` reaches `recv_remote_signal` via an actual network
/// zome call to the receiving agent, which Holochain rejects by default
/// unless that function has an explicit capability grant -- this is easy to
/// miss since `send_remote_signal` is fire-and-forget and won't surface the
/// rejection as an error on the sending side.
#[hdk_extern]
pub fn init() -> ExternResult<InitCallbackResult> {
    prepare_device(())?;
    Ok(InitCallbackResult::Pass)
}

/// What this device needs to take part, set up if it isn't: the grant that
/// lets signals reach it, and its background work. Init does it once; the
/// app calls it on every start too, because an account restored onto a new
/// device skips init and arrives with neither -- the grant is private to
/// the device that wrote it, and schedules are the conductor's own state.
/// Writes nothing on a device that's already set up.
#[hdk_extern]
pub fn prepare_device(_: ()) -> ExternResult<()> {
    relay_coordinator_support::ensure_open_calls("recv_remote_signal", &["recv_remote_signal"])?;
    // Chat and live location arrive as direct signals (see `live`).
    relay_coordinator_support::ensure_direct_signals("live")?;
    // Each party collects what it's owed from its own conductor, and a store
    // makes its decisions -- see `settlement::settle_periodically`.
    schedule("settle_periodically")?;
    // Tending a customer's waiting orders and answering a store's new ones
    // -- see `upkeep`.
    schedule("tend_orders_periodically")?;
    Ok(())
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
/// signal has been checked.
#[derive(Serialize, Deserialize, Debug)]
pub enum LocalSignal {
    /// A new order for one of this agent's stores to accept.
    OrderPlaced(ActionHash),
    /// An order this agent is party to changed -- what it changed to (read
    /// from the new version itself), and which side of it this agent is on.
    OrderUpdated { order_hash: ActionHash, change: OrderChange, role: OrderRole },
    /// An order this agent is party to changed, but the new version hasn't
    /// reached this agent yet: refresh, there's nothing verified to say.
    OrderChanged(ActionHash),
    BidPlaced(ActionHash),
    BidAccepted(ActionHash),
    BidReleased(ActionHash),
    /// See `pickup::mark_ready_for_pickup` -- merchant -> requester only.
    PickupReady(ActionHash),
    /// The driver says this order reached the customer: confirm it, or
    /// report a problem, within the window.
    HandoffRecorded(ActionHash),
    /// The customer reported items missing or wrong on this order.
    IssueReported(ActionHash),
    /// The store handed this order over to this agent, its driver.
    HandedOver(ActionHash),
    /// This agent's store's customer asked to collect this order.
    CollectRequested(ActionHash),
    /// Something changed on an order whose customer's app may be closed:
    /// hand this wake token to the network's push relay (docs/MOBILE.md). Only
    /// the store and the driver hold one, each their own.
    Wake(String),
}

/// Peer-to-peer signals, only ever between an order's own parties.
#[derive(Serialize, Deserialize, Debug)]
pub enum RemoteSignal {
    /// Sent to a store when an order arrives for it to accept.
    OrderPlaced { order_hash: ActionHash },
    /// Sent to each of an order's other parties whenever it changes (see
    /// `post_commit`): `version` is the update, which the receiver reads
    /// for itself.
    OrderUpdated { order_hash: ActionHash, version: ActionHash },
    BidPlaced { order_hash: ActionHash, bid_hash: ActionHash },
    BidAccepted { bid_hash: ActionHash },
    BidReleased { bid_hash: ActionHash },
    /// From a pickup order's store to its customer only.
    PickupReady { order_hash: ActionHash },
    /// From a party who's given back part of an order's held money, to the
    /// party who paid it: there's something to collect (see `settlement`).
    Returned { order_hash: ActionHash },
    /// From the driver to the customer: they've recorded handing the order
    /// over.
    HandoffRecorded { order_hash: ActionHash },
    /// From the customer to the store: they've reported items missing or
    /// wrong.
    IssueReported { order_hash: ActionHash },
    /// From the store to the driver: it's handed the order over -- their app
    /// picks it up on the store's record.
    HandedOver { order_hash: ActionHash },
    /// From the customer to the store: they've asked to collect it.
    CollectRequested { order_hash: ActionHash },
}

/// An order's parties and what it is now, from one version of it.
struct OrderState {
    placed: bool,
    change: OrderChange,
    requester: AgentPubKey,
    merchant: AgentPubKey,
    driver: Option<AgentPubKey>,
}

impl OrderState {
    fn of(record: &Record) -> Option<Self> {
        if let Some(order) = decode_or::<DeliveryOrder>(record) {
            let driver = order.accepted_bid.as_ref().and_then(|bid_ref| resolve_latest_decoded::<Bid>(bid_ref.clone(), "Bid").ok()).map(|(_, bid)| bid.bidder);
            return Some(Self {
                placed: order.status == DeliveryStatus::Placed,
                change: OrderChange::Delivery { status: order.status, cancellation: order.cancellation },
                requester: order.requester,
                merchant: order.merchant,
                driver,
            });
        }
        let order = decode_or::<PickupOrder>(record)?;
        Some(Self {
            placed: order.status == PickupStatus::Placed,
            change: OrderChange::Pickup { status: order.status, cancellation: order.cancellation },
            requester: order.requester,
            merchant: order.merchant,
            driver: None,
        })
    }

    /// Each party, with their side of the order.
    fn parties(&self) -> Vec<(AgentPubKey, OrderRole)> {
        [Some((self.requester.clone(), OrderRole::Customer)), Some((self.merchant.clone(), OrderRole::Store)), self.driver.clone().map(|d| (d, OrderRole::Driver))]
            .into_iter()
            .flatten()
            .collect()
    }

    fn role_of(&self, agent: &AgentPubKey) -> Option<OrderRole> {
        self.parties().into_iter().find(|(party, _)| party == agent).map(|(_, role)| role)
    }
}

/// The order as it stands, as this agent can see it.
fn current_state(order_hash: &ActionHash) -> Option<OrderState> {
    OrderState::of(&resolve_latest(order_hash.clone()).ok()?)
}

#[hdk_extern]
pub fn recv_remote_signal(payload: RemoteSignal) -> ExternResult<()> {
    let sender = call_info()?.provenance;
    let me = agent_info()?.agent_initial_pubkey;
    match payload {
        // A store set to auto-accept answers it from its conductor.
        RemoteSignal::OrderPlaced { order_hash } => {
            // Anyone can send this, and the order routinely arrives after its
            // notice -- so it wakes the answering sweep regardless. That's
            // harmless: the sweep re-reads every waiting order from the
            // network and checks it, and scheduling is idempotent, so a flood
            // keeps it to one run per scheduler tick.
            upkeep::answer_new_orders_soon()?;
            // The screen (and its new-order chime) hears only of an order it
            // can see: placed with this store, by the sender.
            match current_state(&order_hash) {
                Some(order) if order.merchant == me && order.requester == sender => emit_signal(LocalSignal::OrderPlaced(order_hash)),
                _ => Ok(()),
            }
        }
        RemoteSignal::OrderUpdated { order_hash, version } => {
            // The new version itself, if it's reached us: written by the
            // sender, as an update of this order.
            let written = get(version.clone(), GetOptions::network())
                .ok()
                .flatten()
                .filter(|record| record.action().author() == &sender && original_action_of(version.clone()).ok().as_ref() == Some(&order_hash));
            let verified = written.as_ref().and_then(OrderState::of);
            match verified {
                Some(order) => {
                    // A party to the order -- or the driver this version
                    // released, who isn't one any more.
                    let released = written.as_ref().map(crate::deliveries::released_driver).transpose()?.flatten();
                    let sender_ok = order.role_of(&sender).is_some() || released.as_ref().is_some_and(|(driver, _)| driver == &sender);
                    match order.role_of(&me) {
                        Some(role) if sender_ok => {
                            if let Some(record) = &written {
                                crate::deliveries::record_what_changed(record, &order_hash, released.as_ref())?;
                            }
                            // Whatever it changed may be the store's or the
                            // driver's to act on -- their apps tend it.
                            match role {
                                OrderRole::Store => upkeep::tend_my_stores_soon()?,
                                OrderRole::Driver => upkeep::tend_my_deliveries_soon()?,
                                OrderRole::Customer => upkeep::tend_my_orders_soon()?,
                            }
                            // Whatever it changed may settle money owed here.
                            schedule("settle_soon")?;
                            emit_signal(LocalSignal::OrderUpdated { order_hash, change: order.change, role })
                        }
                        _ => Ok(()),
                    }
                }
                None => match current_state(&order_hash) {
                    Some(order) if order.role_of(&me).is_some() => {
                        schedule("settle_soon")?;
                        emit_signal(LocalSignal::OrderChanged(order_hash))
                    }
                    _ => Ok(()),
                },
            }
        }
        RemoteSignal::BidPlaced { order_hash, bid_hash } => {
            let wrong_order = current_state(&order_hash).is_some_and(|order| order.requester != me);
            let wrong_bidder = resolve_latest_decoded::<Bid>(bid_hash.clone(), "Bid").is_ok_and(|(_, bid)| bid.bidder != sender);
            if wrong_order || wrong_bidder {
                return Ok(());
            }
            // A customer matching automatically counts from the first bid.
            upkeep::tend_my_orders_soon()?;
            emit_signal(LocalSignal::BidPlaced(bid_hash))
        }
        RemoteSignal::BidAccepted { bid_hash } | RemoteSignal::BidReleased { bid_hash } if !bid_from(&bid_hash, &me, &sender) => Ok(()),
        RemoteSignal::BidAccepted { bid_hash } => {
            // The driver's app commits to it at once.
            upkeep::tend_my_deliveries_soon()?;
            emit_signal(LocalSignal::BidAccepted(bid_hash))
        }
        RemoteSignal::BidReleased { bid_hash } => emit_signal(LocalSignal::BidReleased(bid_hash)),
        RemoteSignal::Returned { order_hash } => {
            if current_state(&order_hash).is_some_and(|order| order.role_of(&me).is_none() || order.role_of(&sender).is_none()) {
                return Ok(());
            }
            // Settling reads every hold and checks every decision, and
            // scheduling is idempotent -- so a stranger's notice about an order
            // not yet seen costs at most one run per scheduler tick.
            schedule("settle_soon")
        }
        RemoteSignal::HandoffRecorded { order_hash } => {
            // Carries a message for the customer, so it must check out.
            match current_state(&order_hash) {
                Some(order) if order.requester == me && order.driver.as_ref() == Some(&sender) => emit_signal(LocalSignal::HandoffRecorded(order_hash)),
                _ => Ok(()),
            }
        }
        RemoteSignal::HandedOver { order_hash } => match current_state(&order_hash) {
            // The driver's app picks it up on the store's record -- which it
            // reads and checks itself, so a stranger's notice costs a look.
            Some(order) if order.driver.as_ref() == Some(&me) && order.merchant == sender => {
                upkeep::tend_my_deliveries_soon()?;
                emit_signal(LocalSignal::HandedOver(order_hash))
            }
            _ => Ok(()),
        },
        RemoteSignal::CollectRequested { order_hash } => match current_state(&order_hash) {
            Some(order) if order.merchant == me && order.requester == sender => {
                upkeep::tend_my_stores_soon()?;
                emit_signal(LocalSignal::CollectRequested(order_hash))
            }
            _ => Ok(()),
        },
        RemoteSignal::IssueReported { order_hash } => match current_state(&order_hash) {
            Some(order) if order.merchant == me && order.requester == sender => emit_signal(LocalSignal::IssueReported(order_hash)),
            _ => Ok(()),
        },
        RemoteSignal::PickupReady { order_hash } => {
            if current_state(&order_hash).is_some_and(|order| order.requester != me || order.merchant != sender) {
                return Ok(());
            }
            emit_signal(LocalSignal::PickupReady(order_hash))
        }
    }
}

/// Whether `bid_hash` could be `me`'s bid, on an order `sender` placed --
/// who may tell a driver their bid was accepted or released. Only a
/// contradiction rules it out.
fn bid_from(bid_hash: &ActionHash, me: &AgentPubKey, sender: &AgentPubKey) -> bool {
    let Ok((_, bid)) = resolve_latest_decoded::<Bid>(bid_hash.clone(), "Bid") else { return true };
    &bid.bidder == me && !current_state(&bid.order_ref).is_some_and(|order| &order.requester != sender)
}

/// After every commit, tells an order's other parties it changed: the store
/// when an order is placed with it (`OrderPlaced`), everyone else on the
/// order otherwise (`OrderUpdated`). One place, so every path that changes
/// an order -- an extern, the conductor's upkeep --
/// signals alike. Best-effort, like every signal: screens still poll.
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
    let Some(order) = OrderState::of(&record) else { return Ok(()) };
    let order_hash = original_action_of(action.as_hash().clone())?;
    let me = agent_info()?.agent_initial_pubkey;
    let mut told: Vec<AgentPubKey> = Vec::new();
    for (party, role) in order.parties() {
        // Nobody needs telling what they just did themselves -- and someone
        // ordering from their own store hears as the customer, once.
        if party == me || told.contains(&party) {
            continue;
        }
        told.push(party.clone());
        let signal = match role {
            // Only the store has anything to do with a new order: accept it.
            OrderRole::Store if order.placed => RemoteSignal::OrderPlaced { order_hash: order_hash.clone() },
            _ if order.placed => continue,
            _ => RemoteSignal::OrderUpdated { order_hash: order_hash.clone(), version: action.as_hash().clone() },
        };
        send_remote_signal(signal, vec![party.clone()])?;
        // A customer's app may be closed: the store or driver telling them
        // wakes it too.
        if role == OrderRole::Customer {
            let _ = wake_customer(&record, &order_hash, &me);
        }
    }
    Ok(())
}

/// Hands the caller's UI the order's customer's wake token, if the caller
/// holds one: the store's sealed copy, or the driver's, in the drop-off
/// shared with them. Best-effort, like every signal.
fn wake_customer(record: &Record, order_hash: &ActionHash, me: &AgentPubKey) -> ExternResult<()> {
    let token = if let Some(order) = decode_or::<DeliveryOrder>(record) {
        if &order.merchant == me {
            order.sealed_wake.as_ref().map(|sealed| open::<String>(&order.requester, sealed)).transpose()?.flatten()
        } else {
            match crate::deliveries::dropoff_share_for(order_hash, me)? {
                Some(share) => open::<DropoffDetails>(&order.requester, &share.sealed)?.and_then(|dropoff| dropoff.wake),
                None => None,
            }
        }
    } else {
        match decode_or::<PickupOrder>(record) {
            Some(order) if &order.merchant == me => order.sealed_wake.as_ref().map(|sealed| open::<String>(&order.requester, sealed)).transpose()?.flatten(),
            _ => None,
        }
    };
    match token {
        Some(token) => emit_signal(LocalSignal::Wake(token)),
        None => Ok(()),
    }
}

/// Tells an order's customer its driver has recorded handing it over --
/// called by `attestation::record_leg`, on the driver's conductor.
#[hdk_extern]
pub fn notify_handoff(order_hash: ActionHash) -> ExternResult<()> {
    let Some(order) = current_state(&order_hash) else { return Ok(()) };
    if order.driver.as_ref() != Some(&agent_info()?.agent_initial_pubkey) {
        return Ok(());
    }
    send_remote_signal(RemoteSignal::HandoffRecorded { order_hash: order_hash.clone() }, vec![order.requester])?;
    if let Ok(record) = resolve_latest(order_hash.clone()) {
        let _ = wake_customer(&record, &order_hash, &agent_info()?.agent_initial_pubkey);
    }
    Ok(())
}
