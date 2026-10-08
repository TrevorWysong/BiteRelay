//! Layers 1 and 2 of the matching mechanism (plan §3): the geohash anchor
//! that indexes open orders for discovery, the cross-zome lookup into
//! `geo_presence` for a bounded candidate pool, and the signal fan-out to
//! exactly that pool. `orders::request_delivery` is the only caller of
//! `notify_nearby_providers`; `get_open_orders_near` is the polling
//! backstop for a provider who missed that signal.

use crate::signals::RemoteSignal;
use dispatch_integrity::{open_order_anchor, LinkTypes, OPEN_ORDER_BUCKET_MILLIS};
use hdi::hash_path::path::Path;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, resolve_latest};
use relay_types::DeliveryCapability;

pub(crate) fn open_order_anchor_path(geohash: &str, bucket: i64) -> ExternResult<hdi::hash_path::path::TypedPath> {
    Path::from(open_order_anchor(geohash, bucket)).typed(LinkTypes::OpenOrderGeohashAnchor)
}

/// Matches `geo_presence_integrity::PRESENCE_GEOHASH_PRECISION` -- duplicated
/// as a small constant here rather than a crate dependency on geo_presence,
/// since coordinator zomes call each other over the zome-call boundary, not
/// via Cargo dependencies. Keep both in sync if this ever changes.
pub(crate) fn geo_presence_precision() -> usize {
    6
}


/// Providers signaled per order, at most -- see architecture plan §9.2. Once
/// beacons are bucketed the candidate pool is already bounded to real
/// concurrent activity, but a genuinely dense cell could still return dozens
/// of drivers to one order; the polling backstop (`get_open_orders_near`)
/// exists precisely so a driver who didn't make this cut still finds the
/// order within ~10-15s, so capping fan-out doesn't reduce match quality,
/// just bounds worst-case signal-sending cost per order to a constant.
pub(crate) const MAX_SIGNAL_FANOUT: usize = 25;

#[derive(Serialize, Deserialize, Debug)]
struct NearbyProviderView {
    provider: AgentPubKey,
    #[allow(dead_code)]
    capabilities: Vec<DeliveryCapability>,
}

/// Resolves a bounded candidate pool from `geo_presence` (DHT anchor read,
/// durable but slow-is-fine), then pushes the new order directly to exactly
/// that pool via `remote_signal` (fast, unacknowledged). No broadcast to
/// unknown peers.
pub(crate) fn notify_nearby_providers(order_hash: &ActionHash, dropoff_geohash: &str) -> ExternResult<()> {
    let response = call(
        CallTargetCell::Local,
        "geo_presence",
        "get_nearby_providers".into(),
        None,
        dropoff_geohash.to_string(),
    )?;
    let ZomeCallResponse::Ok(extern_io) = response else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "get_nearby_providers cross-zome call failed".into()
        )));
    };
    let nearby: Vec<NearbyProviderView> = extern_io.decode().map_err(|e| wasm_error!(e))?;
    if nearby.is_empty() {
        return Ok(());
    }
    let receivers: Vec<AgentPubKey> = cap_fanout(nearby).into_iter().map(|p| p.provider).collect();
    send_remote_signal(
        RemoteSignal::NewOrderPosted { order_hash: order_hash.clone() },
        receivers,
    )
}

/// Pulled out of `notify_nearby_providers` as a pure function specifically
/// so the cap itself (architecture plan §9.2) is unit-testable without a
/// live conductor -- proving "more than `MAX_SIGNAL_FANOUT` candidates get
/// truncated" doesn't need dozens of real driver conductors signaled live,
/// just this one deterministic `Vec::truncate` call.
fn cap_fanout(mut candidates: Vec<NearbyProviderView>) -> Vec<NearbyProviderView> {
    candidates.truncate(MAX_SIGNAL_FANOUT);
    candidates
}

/// Polling backstop for providers who may have missed the fire-and-forget
/// signal -- see plan §3. Callers are expected to call this every ~10-15s
/// while marked available.
#[hdk_extern]
pub fn get_open_orders_near(geohash: String) -> ExternResult<Vec<Record>> {
    use dispatch_integrity::DeliveryOrder;
    use dispatch_integrity::DeliveryStatus;

    let now = sys_time()?;
    let current_bucket = relay_types::time_bucket(now.as_millis(), OPEN_ORDER_BUCKET_MILLIS);
    let mut orders = Vec::new();
    for cell in relay_types::cell_and_neighbors(&geohash) {
        // Current bucket and the immediately preceding one -- see
        // architecture plan §9.2 and geo_presence's identical treatment.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_provider(n: u8) -> NearbyProviderView {
        NearbyProviderView {
            provider: AgentPubKey::from_raw_36(vec![n; 36]),
            capabilities: vec![DeliveryCapability::Food],
        }
    }

    #[test]
    fn cap_fanout_truncates_to_the_max() {
        let candidates: Vec<NearbyProviderView> = (0..(MAX_SIGNAL_FANOUT as u8 + 10)).map(dummy_provider).collect();
        let capped = cap_fanout(candidates);
        assert_eq!(capped.len(), MAX_SIGNAL_FANOUT);
    }

    #[test]
    fn cap_fanout_leaves_a_smaller_pool_untouched() {
        let candidates: Vec<NearbyProviderView> = (0..3).map(dummy_provider).collect();
        let capped = cap_fanout(candidates);
        assert_eq!(capped.len(), 3);
    }
}
