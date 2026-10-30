//! Bidding: placing a bid against an open order, withdrawing one, and
//! accepting one. `accept_bid` is the single DHT commit that matters for
//! the matching flow -- everything before it is off-DHT signal
//! traffic (see `matching.rs`).

use crate::signals::RemoteSignal;
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{guest, next_page_cursor, original_action_of, resolve_latest_decoded, resolve_links_to_records, resolve_version_decoded, update_version, written};

#[derive(Serialize, Deserialize, Debug)]
pub struct SubmitBidInput {
    pub order_ref: ActionHash,
    pub eta_seconds: u32,
    /// How long until they'd reach the store -- when they're due there.
    #[serde(default)]
    pub to_store_seconds: u32,
    pub price_offer: u64,
}

#[hdk_extern]
pub fn submit_bid(input: SubmitBidInput) -> ExternResult<Record> {
    let bidder = agent_info()?.agent_initial_pubkey;
    // `order_ref` may name the order's identity or any version of it; the
    // bid names the current one, which validation requires to be Open (the
    // store's acceptance, the version drivers discover).
    let (current, order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_ref.clone(), "DeliveryOrder")?;
    if order.status != DeliveryStatus::Open {
        return Err(guest("This order isn't taking offers any more."));
    }
    // One bid per driver per order -- validation's rule, told first. Each
    // bid is linked from its order by its bidder.
    let order_original = original_action_of(input.order_ref.clone())?;
    let sent = LinkQuery::try_new(order_original.clone(), LinkTypes::OrderToBid)?.author(bidder.clone());
    if !get_links(sent, GetStrategy::Local)?.is_empty() {
        return Err(guest("You've already bid on this order."));
    }
    if let Err(refusal) = crate::order_queues::get_driver_load(bidder.clone())?.taking(order.priority, relay_governance::max_concurrent_deliveries()) {
        return Err(guest(driver_refusal(refusal)));
    }

    // The driver's verification, where the network requires one.
    let verification = crate::verification::driver_verification(bidder.clone())?.map(|v| v.action);
    if verification.is_none() && relay_governance::require_verified_drivers() {
        return Err(guest("Drivers on this network are verified before they deliver. Ask one of its verifiers to check you."));
    }

    let bid = Bid {
        order_ref: current.action_address().clone(),
        bidder,
        eta_seconds: input.eta_seconds,
        to_store_seconds: input.to_store_seconds.min(input.eta_seconds),
        price_offer: input.price_offer,
        // What the driver will post when they pick the order up.
        collateral: required_collateral(&order),
        status: BidStatus::Open,
        created_at: sys_time()?,
        verification,
    };
    let bid_hash = create_entry(&EntryTypes::Bid(bid))?;
    // Under the order's identity, not the exact version bid on (a scheduled
    // order is bid on via the update that opened it), so the customer finds
    // every bid in one place.
    create_link(order_original.clone(), bid_hash.clone(), LinkTypes::OrderToBid, ())?;

    let _ = send_remote_signal(
        RemoteSignal::BidPlaced { order_hash: order_original, bid_hash: bid_hash.clone() },
        vec![order.requester],
    );

    written(bid_hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct WithdrawBidInput {
    pub bid_action: ActionHash,
}

#[hdk_extern]
pub fn withdraw_bid(input: WithdrawBidInput) -> ExternResult<Record> {
    let (current, mut bid): (_, Bid) = resolve_version_decoded(input.bid_action, "Bid")?;
    bid.status = BidStatus::Withdrawn;
    let updated = update_version(&current, &EntryTypes::Bid(bid), LinkTypes::Version)?;
    written(updated)
}

/// Contested warrants. Warrant-checking cannot be
/// enforced inside deterministic `validate()` -- an agent's warrant set is an
/// ever-growing, gossip-propagated fact, so two validators asking "does this
/// agent have warrants" at slightly different moments could get different,
/// both-honest answers. This is necessarily coordinator-level, best-effort
/// trust, the same tier as the ledger stub's single-party trust -- named
/// honestly, not implied to be network-enforced.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct WarrantSummary {
    pub count: usize,
    pub has_chain_fork: bool,
    pub has_invalid_chain_op: bool,
}

/// Uses `ActivityRequest::Status` -- the cheapest request shape, a summary
/// plus warrants only, not the agent's whole chain (`ActivityRequest::Full`
/// would pull that unnecessarily just to see whether warrants exist).
#[hdk_extern]
pub fn check_warrants(agent: AgentPubKey) -> ExternResult<WarrantSummary> {
    let activity = get_agent_activity(agent, ChainQueryFilter::new(), ActivityRequest::Status, GetOptions::network())?;
    let mut summary = WarrantSummary { count: activity.warrants.len(), ..Default::default() };
    for signed_warrant in &activity.warrants {
        match &signed_warrant.proof {
            WarrantProof::ChainIntegrity(ChainIntegrityWarrant::ChainFork { .. }) => summary.has_chain_fork = true,
            WarrantProof::ChainIntegrity(ChainIntegrityWarrant::InvalidChainOp { .. }) => summary.has_invalid_chain_op = true,
        }
    }
    Ok(summary)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct AcceptBidInput {
    pub order_original_action: ActionHash,
    pub bid_action: ActionHash,
    /// Refuses by default if the winning bid's bidder has any outstanding
    /// warrants -- the app can't erase or adjudicate the cryptographic fact
    /// of a warrant, but a hard, no-recourse block risks permanently
    /// stranding an agent over a stale or unrelated incident, so the
    /// requester gets to make an informed call rather than the protocol
    /// deciding unconditionally. Defaults to `false` via `#[serde(default)]`
    /// so existing callers that predate this field keep the safe behavior.
    #[serde(default)]
    pub override_warrants: bool,
}

/// The only DHT write in the matching flow that matters for settlement: the
/// order transitions to BidAccepted and records which bid won. Losing bids
/// are never written to -- their bidders just get a
/// BidReleased signal so their client can drop the local candidate.
#[hdk_extern]
pub fn accept_bid(input: AcceptBidInput) -> ExternResult<Record> {
    let (order_record, mut order): (_, DeliveryOrder) = resolve_version_decoded(input.order_original_action.clone(), "DeliveryOrder")?;
    let (_, winning_bid): (_, Bid) = resolve_latest_decoded(input.bid_action.clone(), "Bid")?;
    if winning_bid.status != BidStatus::Open {
        return Err(guest("That driver has withdrawn their offer."));
    }
    crate::accounts::ensure_not_moved(&winning_bid.bidder, "That driver")?;
    if !crate::verification::bid_verification_stands(&winning_bid)? {
        return Err(guest("That driver's verification has been withdrawn."));
    }

    if !input.override_warrants {
        let warrants = check_warrants(winning_bid.bidder.clone())?;
        if warrants.count > 0 {
            return Err(guest(format!(
                "the winning bidder has {} outstanding warrant(s) -- pass override_warrants: true to accept anyway",
                warrants.count
            )));
        }
    }

    // An order changes drivers a bounded number of times.
    if let Some(version) = dispatch_integrity::lineage::Version::of(order_record.record.clone()) {
        if !dispatch_integrity::lineage::driver_changes(&version)?.allow_another() {
            return Err(guest("This order has changed drivers too many times. You can collect it yourself, or cancel it."));
        }
    }

    // Never more orders than a driver may carry, nor a priority order with
    // anything else.
    if let Err(refusal) = crate::order_queues::get_driver_load(winning_bid.bidder.clone())?.taking(order.priority, relay_governance::max_concurrent_deliveries()) {
        return Err(guest(customer_refusal(refusal)));
    }

    // The driver learns the exact drop-off only once they've committed (see
    // `deliveries::share_address`); accepting them needs the customer's own
    // copy, which only the customer can open.
    let me = agent_info()?.agent_initial_pubkey;
    if order.requester != me {
        return Err(guest("Only the order's customer can accept an offer on it."));
    }
    order.status = DeliveryStatus::BidAccepted;
    order.accepted_bid = Some(input.bid_action.clone());
    // The driver's pay -- the customer's share of the fee, and their tip --
    // set aside in this same commit.
    order.driver_pay_hold = crate::settlement::place_hold(&input.order_original_action, HoldPurpose::DriverPay { bid: input.bid_action.clone() })?;
    let updated = update_version(&order_record, &EntryTypes::DeliveryOrder(order), LinkTypes::Version)?;
    crate::order_queues::enqueue_for_driver(&input.order_original_action, &updated, &winning_bid.bidder)?;

    let _ = send_remote_signal(
        RemoteSignal::BidAccepted { bid_hash: input.bid_action.clone() },
        vec![winning_bid.bidder.clone()],
    );

    let links = get_links(
        LinkQuery::try_new(input.order_original_action, LinkTypes::OrderToBid)?,
        GetStrategy::default(),
    )?;
    for link in links {
        let Some(other_bid_hash) = link.target.into_action_hash() else { continue };
        if other_bid_hash == input.bid_action {
            continue;
        }
        if let Ok((_, other_bid)) = resolve_latest_decoded::<Bid>(other_bid_hash.clone(), "Bid") {
            let _ = send_remote_signal(RemoteSignal::BidReleased { bid_hash: other_bid_hash }, vec![other_bid.bidder]);
        }
    }

    written(updated)
}

/// Why a driver can't take an order on, told to them.
fn driver_refusal(refusal: CarryRefusal) -> String {
    match refusal {
        CarryRefusal::CarryingPriority => "You're on a priority delivery, which goes on its own. Finish it before taking another.".into(),
        CarryRefusal::PriorityGoesAlone => "This is a priority order: it goes to a driver with no other orders. Finish yours first.".into(),
        CarryRefusal::AtLimit => format!("You have {} orders, the most at once. Finish one before taking another.", relay_governance::max_concurrent_deliveries()),
    }
}

/// Why a customer can't give their order to a driver, told to them.
fn customer_refusal(refusal: CarryRefusal) -> &'static str {
    match refusal {
        CarryRefusal::CarryingPriority => "This driver is on a priority delivery right now. Choose another driver.",
        CarryRefusal::PriorityGoesAlone => "Your order is priority, and this driver has other orders. Choose a driver with none.",
        CarryRefusal::AtLimit => "This driver has as many orders as they can carry. Choose another driver.",
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ListBidsInput {
    pub order_ref: ActionHash,
    /// Page cursor -- pass back the previous call's `next_after` to continue.
    /// `None` starts from the beginning. Bids-per-order is naturally small
    /// (unlike the shared cross-user anchors in `matching.rs`,
    /// this is scoped to one order), so this is defensive pagination rather
    /// than a fix for a known hot spot.
    pub after: Option<Timestamp>,
}

const BID_PAGE_SIZE: usize = 50;

#[derive(Serialize, Deserialize, Debug)]
pub struct BidsPage {
    pub bids: Vec<Record>,
    pub next_after: Option<Timestamp>,
}

#[hdk_extern]
pub fn list_bids_for_order(input: ListBidsInput) -> ExternResult<BidsPage> {
    let mut query = LinkQuery::try_new(input.order_ref, LinkTypes::OrderToBid)?;
    query.after = input.after;
    let mut links = get_links(query, GetStrategy::default())?;
    links.sort_by_key(|l| l.timestamp);
    let next_after = if links.len() > BID_PAGE_SIZE { Some(next_page_cursor(links[BID_PAGE_SIZE - 1].timestamp)) } else { None };
    links.truncate(BID_PAGE_SIZE);
    let bids = resolve_links_to_records(links);
    Ok(BidsPage { bids, next_after })
}
