//! Bidding: placing a bid against an open order, withdrawing one, and
//! accepting one. `accept_bid` is the single DHT commit that matters for
//! the matching flow (plan §3) -- everything before it is off-DHT signal
//! traffic (see `matching.rs`).

use crate::signals::RemoteSignal;
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{next_page_cursor, resolve_latest};
use relay_types::LedgerCommitmentRef;

#[derive(Serialize, Deserialize, Debug)]
pub struct SubmitBidInput {
    pub order_ref: ActionHash,
    pub eta_seconds: u32,
    pub price_offer: u64,
    pub collateral_commitment: LedgerCommitmentRef,
}

/// Queries the caller's own source chain directly for every `Bid` they've
/// authored -- a driver's own bids never need gossip or a link to discover,
/// since they're already sitting on that driver's own chain. Same pattern
/// as `attestation_coordinator::list_my_receipts`: a driver's dashboard has
/// no other way to answer "which orders am I bidding on/delivering" --
/// there's no BidderToOrder link, unlike RequesterToOrder/MerchantToOrder.
#[hdk_extern]
pub fn list_my_bids(_: ()) -> ExternResult<Vec<Record>> {
    let dummy = EntryTypes::Bid(Bid {
        order_ref: ActionHash::from_raw_36(vec![0; 36]),
        bidder: agent_info()?.agent_initial_pubkey,
        eta_seconds: 0,
        price_offer: 0,
        collateral_commitment: LedgerCommitmentRef { account: String::new(), amount: 0, ledger_txn_ref: String::new() },
        status: BidStatus::Open,
        created_at: Timestamp(0),
    });
    let scoped: ScopedEntryDefIndex = (&dummy).try_into().map_err(|e: WasmError| e)?;
    let visibility = EntryVisibility::from(&dummy);
    let filter = ChainQueryFilter::new()
        .entry_type(EntryType::App(AppEntryDef::new(scoped.zome_type, scoped.zome_index, visibility)))
        .include_entries(true);
    query(filter)
}

#[hdk_extern]
pub fn submit_bid(input: SubmitBidInput) -> ExternResult<Record> {
    let bidder = agent_info()?.agent_initial_pubkey;
    let order_record = resolve_latest(input.order_ref.clone())?;
    let order: DeliveryOrder = order_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a DeliveryOrder".into())))?;

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
    create_link(input.order_ref.clone(), bid_hash.clone(), LinkTypes::OrderToBid, ())?;

    let _ = send_remote_signal(
        RemoteSignal::BidPlaced { order_hash: input.order_ref, bid_hash: bid_hash.clone() },
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
    let record = resolve_latest(input.bid_action)?;
    let mut bid: Bid = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a Bid".into())))?;
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
    let order_record = resolve_latest(input.order_original_action.clone())?;
    let mut order: DeliveryOrder = order_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a DeliveryOrder".into())))?;

    let bid_record = resolve_latest(input.bid_action.clone())?;
    let winning_bid: Bid = bid_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest("record is not a Bid".into())))?;

    if !input.override_warrants {
        let warrants = check_warrants(winning_bid.bidder.clone())?;
        if warrants.count > 0 {
            return Err(wasm_error!(WasmErrorInner::Guest(format!(
                "the winning bidder has {} outstanding warrant(s) -- pass override_warrants: true to accept anyway",
                warrants.count
            ))));
        }
    }

    order.status = DeliveryStatus::BidAccepted;
    order.accepted_bid = Some(input.bid_action.clone());
    // order_record came from resolve_latest, so its action_address() is the
    // real current chain tip -- see resolve_latest's doc comment for why
    // that matters (a plain get() would not give this).
    let updated = update_entry(order_record.action_address().clone(), &EntryTypes::DeliveryOrder(order))?;

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
        if let Ok(other_record) = resolve_latest(other_bid_hash.clone()) {
            if let Ok(Some(other_bid)) = other_record.entry().to_app_option::<Bid>() {
                let _ = send_remote_signal(
                    RemoteSignal::BidReleased { bid_hash: other_bid_hash },
                    vec![other_bid.bidder],
                );
            }
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
    let mut bids = Vec::with_capacity(links.len());
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if let Ok(record) = resolve_latest(action_hash) {
            bids.push(record);
        }
    }
    Ok(BidsPage { bids, next_after })
}
