//! Coordinator zome for Layer 1 of the matching mechanism (plan §3):
//! providers publish short-lived presence beacons to a geohash anchor,
//! and `get_nearby_providers` is the bounded candidate-pool lookup
//! `dispatch` uses before ever sending a signal.

use geo_presence_integrity::*;
use hdi::hash_path::path::Path;
use hdk::prelude::*;
use relay_types::{DeliveryCapability, GeoPoint};

/// How long a beacon is valid for after being published. Refresh cadence on
/// the client should be well inside this window (45-60s), deliberately not
/// faster -- see PRESENCE_GEOHASH_PRECISION doc comment in the integrity crate.
pub const BEACON_TTL_MILLIS: i64 = 90_000;

/// Time bucket folded into the anchor path (architecture plan §9.2) so each
/// bucket is a distinct base hash with a naturally bounded link set -- a
/// single active provider refreshing every 45-60s all day would otherwise
/// accumulate one never-superseded, never-deleted link per refresh, forever,
/// on one shared per-cell anchor. 2 minutes: comfortably above both the
/// refresh cadence and Kitsune2's own ~1-minute gossip floor, so bucketing
/// any finer than this buys nothing.
pub const BEACON_BUCKET_MILLIS: i64 = 120_000;

fn geohash_anchor_path(geohash: &str, bucket: i64) -> ExternResult<hdi::hash_path::path::TypedPath> {
    Path::from(format!("presence_geohash.{}.{}", geohash, bucket)).typed(LinkTypes::GeohashToBeacon)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct AnnounceOnlineInput {
    pub location: GeoPoint,
    pub capabilities: Vec<DeliveryCapability>,
}

#[hdk_extern]
pub fn announce_online(input: AnnounceOnlineInput) -> ExternResult<Record> {
    let provider = agent_info()?.agent_initial_pubkey;
    let now = sys_time()?;
    let geohash = relay_types::encode(input.location, PRESENCE_GEOHASH_PRECISION);
    let beacon = PresenceBeacon {
        provider: provider.clone(),
        geohash: geohash.clone(),
        capabilities: input.capabilities,
        expires_at: (now + std::time::Duration::from_millis(BEACON_TTL_MILLIS as u64))
            .map_err(|e| wasm_error!(WasmErrorInner::Guest(e.to_string())))?,
    };
    let action_hash = create_entry(&EntryTypes::PresenceBeacon(beacon))?;
    create_link(provider, action_hash.clone(), LinkTypes::AgentToBeacon, ())?;

    let bucket = relay_types::time_bucket(now.as_millis(), BEACON_BUCKET_MILLIS);
    let path = geohash_anchor_path(&geohash, bucket)?;
    path.ensure()?;
    create_link(path.path_entry_hash()?, action_hash.clone(), LinkTypes::GeohashToBeacon, ())?;

    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back beacon".into())))
}

/// Publishes an already-expired beacon so nearby queries stop returning this
/// provider immediately, rather than waiting out the natural TTL.
#[hdk_extern]
pub fn announce_offline(_: ()) -> ExternResult<()> {
    let provider = agent_info()?.agent_initial_pubkey;
    let now = sys_time()?;
    let beacon = PresenceBeacon {
        provider: provider.clone(),
        geohash: "000000".into(),
        capabilities: vec![DeliveryCapability::Food, DeliveryCapability::Goods],
        expires_at: now,
    };
    create_entry(&EntryTypes::PresenceBeacon(beacon))?;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct NearbyProvider {
    pub provider: AgentPubKey,
    pub capabilities: Vec<DeliveryCapability>,
}

/// Layer 1 of the matching mechanism: a bounded, DHT-durable candidate pool
/// resolved by geohash before any signal is sent. Callers pass the
/// requester's own geohash; this searches that cell and its 8 neighbors.
#[hdk_extern]
pub fn get_nearby_providers(geohash: String) -> ExternResult<Vec<NearbyProvider>> {
    let now = sys_time()?;
    let current_bucket = relay_types::time_bucket(now.as_millis(), BEACON_BUCKET_MILLIS);
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();

    for cell in relay_types::cell_and_neighbors(&geohash) {
        // Current bucket and the immediately preceding one -- a beacon
        // published just before a bucket boundary would otherwise be
        // briefly invisible to a reader who queries just after it rolls
        // over. See architecture plan §9.2.
        for bucket in [current_bucket, current_bucket - 1] {
            let path = geohash_anchor_path(&cell, bucket)?;
            let path_hash = match path.path_entry_hash() {
                Ok(hash) => hash,
                Err(_) => continue,
            };
            let links = get_links(
                LinkQuery::try_new(path_hash, LinkTypes::GeohashToBeacon)?,
                GetStrategy::default(),
            )?;
            for link in links {
                let Some(action_hash) = link.target.into_action_hash() else { continue };
                let Some(record) = get(action_hash, GetOptions::local())? else { continue };
                let Some(beacon): Option<PresenceBeacon> =
                    record.entry().to_app_option().map_err(|e| wasm_error!(e))?
                else {
                    continue;
                };
                if beacon.expires_at < now {
                    continue;
                }
                if !seen.insert(beacon.provider.clone()) {
                    continue;
                }
                out.push(NearbyProvider {
                    provider: beacon.provider,
                    capabilities: beacon.capabilities,
                });
            }
        }
    }
    Ok(out)
}
