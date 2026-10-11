//! How drivers find work: every open order is indexed under its drop-off's
//! geohash cell (and a time bucket, so a read is bounded by recent orders,
//! never all of history), and a driver who's online reads the cells around
//! them (`get_open_orders_near`).
//!
//! Drivers pull; they never announce where they are. Anything a driver
//! published -- a presence beacon, say -- would be signed with their key,
//! and anyone could follow them through a shift (and home at the end of it).
//! So the only trace a driver's location leaves is a read of a public list,
//! seen only by whichever peer happens to store that list.

use dispatch_integrity::{open_order_anchor, LinkTypes, OPEN_ORDER_BUCKET_MILLIS};
use hdi::hash_path::path::Path;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, original_action_of, resolve_latest};

pub(crate) fn open_order_anchor_path(geohash: &str, bucket: i64) -> ExternResult<hdi::hash_path::path::TypedPath> {
    Path::from(open_order_anchor(geohash, bucket)).typed(LinkTypes::OpenOrderGeohashAnchor)
}

/// Open orders in `geohash` and its neighbouring cells -- what an online
/// driver's app reads every few seconds.
#[hdk_extern]
pub fn get_open_orders_near(geohash: String) -> ExternResult<Vec<Record>> {
    use dispatch_integrity::DeliveryOrder;
    use dispatch_integrity::DeliveryStatus;

    let now = sys_time()?;
    let current_bucket = relay_types::time_bucket(now.as_millis(), OPEN_ORDER_BUCKET_MILLIS);
    let mut orders = Vec::new();
    for cell in relay_types::cell_and_neighbors(&geohash) {
        // Current bucket and the immediately preceding one -- see
        // architecture plan §9.2.
        for bucket in [current_bucket, current_bucket - 1] {
            let path = open_order_anchor_path(&cell, bucket)?;
            let path_hash = match path.path_entry_hash() {
                Ok(hash) => hash,
                Err(_) => continue,
            };
            let links = get_links(
                LinkQuery::try_new(path_hash, LinkTypes::OpenOrderGeohashAnchor)?,
                GetStrategy::default(),
            )?;
            for link in links {
                let Some(action_hash) = link.target.into_action_hash() else { continue };
                // Anchor links point at the store's acceptance (the version
                // that opened the order) -- resolve_latest is what makes this
                // reflect the order's real current status rather than
                // showing it as forever Open. Bids name that same version.
                let Ok(record) = resolve_latest(action_hash) else { continue };
                let Some(order) = decode_or::<DeliveryOrder>(&record) else { continue };
                if order.status == DeliveryStatus::Open {
                    orders.push(record);
                }
            }
        }
    }
    Ok(orders)
}

// --- matching a customer's order automatically ---

/// One bid as the matching rule weighs it.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RankedBid {
    pub bid: ActionHash,
    /// What the rule counts it as, in minor units: lowest wins.
    pub cost: u64,
    /// Why it can't be chosen now, if it can't.
    pub unavailable: Option<String>,
}

/// The bids on an order, as its app would choose among them, best first:
/// the network's published rule, the same for everyone --
///
/// > its price, plus each minute until the driver would hand it over at
/// > the network's `minute_value_cents`, plus its price again in the share
/// > of the driver's committed deliveries they've dropped
///
/// -- so a faster driver can win at a higher price, and a driver who
/// drops orders has to bid lower to win. Ties go to the earlier bid. A bid
/// over the customer's cap, from a driver who left this order, or from one
/// who can't take it on now is listed but can't be chosen.
#[hdk_extern]
pub fn rank_bids(order_ref: ActionHash) -> ExternResult<Vec<RankedBid>> {
    let order_ref = original_action_of(order_ref)?;
    let latest = resolve_latest(order_ref.clone())?;
    let order = decode_or::<dispatch_integrity::DeliveryOrder>(&latest).ok_or(wasm_error!(WasmErrorInner::Guest("not a delivery".into())))?;
    Ok(ranked(&order_ref, &latest, &order)?.into_iter().map(|(ranked, _)| ranked).collect())
}

/// The ranking, with when each bid was placed.
fn ranked(order_ref: &ActionHash, latest: &Record, order: &dispatch_integrity::DeliveryOrder) -> ExternResult<Vec<(RankedBid, Timestamp)>> {
    use dispatch_integrity::{lineage, Bid, BidStatus};
    // Drivers who've left this order already.
    let left: Vec<ActionHash> = {
        let mut left = Vec::new();
        if let Some(version) = lineage::Version::of(latest.clone()) {
            lineage::find_back(version, |v, p| {
                if let Some(bid) = p.and_then(|p| v.released(p)) {
                    left.push(bid);
                }
                None::<()>
            })?;
        }
        left
    };
    let minute_value = relay_governance::minute_value_cents();
    let max = relay_governance::max_concurrent_deliveries();
    let mut ranked = Vec::new();
    for link in get_links(LinkQuery::try_new(order_ref.clone(), LinkTypes::OrderToBid)?, GetStrategy::default())? {
        let Some(bid_ref) = link.target.into_action_hash() else { continue };
        let Ok(record) = resolve_latest(bid_ref.clone()) else { continue };
        let Some(bid) = decode_or::<Bid>(&record) else { continue };
        if bid.status != BidStatus::Open || original_action_of(bid.order_ref.clone()).ok().as_ref() != Some(order_ref) || record.action().author() != &bid.bidder {
            continue;
        }
        let summary = driver_record(&bid.bidder)?;
        let attempts = u64::from(summary.completed_count) + u64::from(summary.dropped_count);
        let reliability = bid.price_offer.saturating_mul(u64::from(summary.dropped_count)).checked_div(attempts).unwrap_or(0);
        let minutes = u64::from(bid.eta_seconds).div_ceil(60);
        let cost = bid.price_offer.saturating_add(minutes.saturating_mul(minute_value)).saturating_add(reliability);
        let unavailable = if order.max_delivery_fee.is_some_and(|cap| bid.price_offer > cap) {
            Some("Over your delivery fee limit.".to_string())
        } else if left.contains(&bid_ref) {
            Some("This driver left your order.".to_string())
        } else if crate::order_queues::get_driver_load(bid.bidder.clone())?.taking(order.priority, max).is_err() {
            Some("This driver can't take another order right now.".to_string())
        } else {
            None
        };
        ranked.push((RankedBid { bid: bid_ref, cost, unavailable }, link.timestamp));
    }
    ranked.sort_by(|(a, at), (b, bt)| (a.unavailable.is_some(), a.cost, *at, &a.bid).cmp(&(b.unavailable.is_some(), b.cost, *bt, &b.bid)));
    Ok(ranked)
}

/// Mirrors the counts of `reputation::ReputationSummary` this rule reads.
#[derive(Deserialize, Debug, Default)]
struct DriverRecord {
    completed_count: u32,
    dropped_count: u32,
}

#[derive(Serialize, Debug)]
enum ReputationTargetWire {
    Driver(AgentPubKey),
}

fn driver_record(driver: &AgentPubKey) -> ExternResult<DriverRecord> {
    match call(CallTargetCell::Local, "reputation", "get_reputation_summary".into(), None, ReputationTargetWire::Driver(driver.clone()))? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e)),
        _ => Ok(DriverRecord::default()),
    }
}

/// For a customer's order set to match automatically: once the bid window
/// has run from its first bid, accepts the best available one. Returns
/// when it should look again, if it should.
pub(crate) fn auto_match(order_ref: &ActionHash, order: &dispatch_integrity::DeliveryOrder, now: i64) -> ExternResult<Option<Timestamp>> {
    let latest = resolve_latest(order_ref.clone())?;
    // Past the network's limit on driver changes, only its customer can
    // decide what happens next.
    if let Some(version) = dispatch_integrity::lineage::Version::of(latest.clone()) {
        if dispatch_integrity::lineage::driver_changes(&version)? >= relay_governance::max_driver_changes() {
            return Ok(None);
        }
    }
    let ranked = ranked(order_ref, &latest, order)?;
    let Some(first) = ranked.iter().map(|(_, at)| *at).min() else { return Ok(None) };
    let closes = first.as_micros().saturating_add(relay_governance::bid_window().as_micros() as i64);
    if now < closes {
        return Ok(Some(Timestamp::from_micros(closes)));
    }
    let Some((best, _)) = ranked.into_iter().find(|(r, _)| r.unavailable.is_none()) else { return Ok(None) };
    // In a call of its own. If it's refused (the driver has a warrant, say),
    // the next bid to arrive brings the app back.
    let accept = crate::bids::AcceptBidInput { order_original_action: order_ref.clone(), bid_action: best.bid, override_warrants: false };
    call(CallTargetCell::Local, zome_info()?.name, "accept_bid".into(), None, accept)?;
    Ok(None)
}
