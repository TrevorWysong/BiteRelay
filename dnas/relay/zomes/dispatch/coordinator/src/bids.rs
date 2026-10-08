//! Bidding: placing a bid against an open order, withdrawing one, and
//! accepting one. `accept_bid` is the single DHT commit that matters for
//! the matching flow (plan §3) -- everything before it is off-DHT signal
//! traffic (see `matching.rs`).

use crate::signals::RemoteSignal;
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{next_page_cursor, open, original_action_of, resolve_latest_decoded, resolve_links_to_records, seal};
use relay_types::LedgerCommitmentRef;

#[derive(Serialize, Deserialize, Debug)]
pub struct SubmitBidInput {
    pub order_ref: ActionHash,
    pub eta_seconds: u32,
    pub price_offer: u64,
    pub collateral_commitment: LedgerCommitmentRef,
}

#[hdk_extern]
pub fn submit_bid(input: SubmitBidInput) -> ExternResult<Record> {
    let bidder = agent_info()?.agent_initial_pubkey;
    let (_, order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_ref.clone(), "DeliveryOrder")?;

    let bid = Bid {
        order_ref: input.order_ref.clone(),
        bidder,
        eta_seconds: input.eta_seconds,
        price_offer: input.price_offer,
        collateral_commitment: input.collateral_commitment,
        status: BidStatus::Open,
        created_at: sys_time()?,
    };
    let bid_hash = create_entry(&EntryTypes::Bid(bid))?;
    // Under the order's identity, not the exact version bid on (a scheduled
    // order is bid on via the update that opened it), so the customer finds
    // every bid in one place.
    let order_original = original_action_of(input.order_ref)?;
    create_link(order_original.clone(), bid_hash.clone(), LinkTypes::OrderToBid, ())?;

    let _ = send_remote_signal(
        RemoteSignal::BidPlaced { order_hash: order_original, bid_hash: bid_hash.clone() },
        vec![order.requester],
    );

    get(bid_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back bid".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct WithdrawBidInput {
    pub bid_action: ActionHash,
}

#[hdk_extern]
pub fn withdraw_bid(input: WithdrawBidInput) -> ExternResult<Record> {
    let (record, mut bid): (_, Bid) = resolve_latest_decoded(input.bid_action, "Bid")?;
    bid.status = BidStatus::Withdrawn;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::Bid(bid))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back withdrawn bid".into())))
}

/// Contested warrants (architecture plan §11.2). Warrant-checking cannot be
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
/// are never written to (see plan §3) -- their bidders just get a
/// BidReleased signal so their client can drop the local candidate.
#[hdk_extern]
pub fn accept_bid(input: AcceptBidInput) -> ExternResult<Record> {
    let (order_record, mut order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_original_action.clone(), "DeliveryOrder")?;
    let (_, winning_bid): (_, Bid) = resolve_latest_decoded(input.bid_action.clone(), "Bid")?;

    if !input.override_warrants {
        let warrants = check_warrants(winning_bid.bidder.clone())?;
        if warrants.count > 0 {
            return Err(wasm_error!(WasmErrorInner::Guest(format!(
                "the winning bidder has {} outstanding warrant(s) -- pass override_warrants: true to accept anyway",
                warrants.count
            ))));
        }
    }

    // The driver learns the exact drop-off only now: the customer opens
    // their own sealed copy and seals it again for this driver alone.
    let me = agent_info()?.agent_initial_pubkey;
    let dropoff: DropoffDetails = open(&me, &order.sealed_dropoff)?.ok_or(wasm_error!(WasmErrorInner::Guest("only the customer can accept a bid on their order".into())))?;
    order.driver_dropoff = Some(seal(&winning_bid.bidder, &dropoff)?);
    order.status = DeliveryStatus::BidAccepted;
    order.accepted_bid = Some(input.bid_action.clone());
    // order_record came from resolve_latest, so its action_address() is the
    // real current chain tip -- see resolve_latest's doc comment for why
    // that matters (a plain get() would not give this).
    let updated = update_entry(order_record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;
    crate::order_queues::enqueue_for_driver(&input.order_original_action, &input.bid_action, &winning_bid.bidder)?;

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

    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back accepted order".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ListBidsInput {
    pub order_ref: ActionHash,
    /// Page cursor -- pass back the previous call's `next_after` to continue.
    /// `None` starts from the beginning. Bids-per-order is naturally small
    /// (unlike the shared cross-user anchors in `matching.rs`/`geo_presence`,
    /// this is scoped to one order), so this is defensive pagination rather
    /// than a fix for a known hot spot -- see architecture plan §9.3.
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
