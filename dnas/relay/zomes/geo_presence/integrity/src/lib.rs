//! Integrity zome for `PresenceBeacon` -- a short-lived, coarse (city-block
//! precision) provider-location claim. Deliberately never carries real-time
//! GPS; see the coordinator crate for the refresh-cadence reasoning.

use hdi::prelude::*;
use relay_integrity_support::{decode, invalid, link_target, path_hash, require, LinkTarget};
use relay_types::DeliveryCapability;

/// How long a beacon is valid for after being published. Refresh cadence on
/// the client should be well inside this window (45-60s), deliberately not
/// faster -- see PRESENCE_GEOHASH_PRECISION's doc comment.
pub const BEACON_TTL_MILLIS: i64 = 90_000;

/// Time bucket folded into the anchor path (architecture plan §9.2) so each
/// bucket is a distinct base hash with a naturally bounded link set -- a
/// single active provider refreshing every 45-60s all day would otherwise
/// accumulate one never-superseded link per refresh, forever, on one shared
/// per-cell anchor. 2 minutes: comfortably above both the refresh cadence
/// and Kitsune2's own ~1-minute gossip floor, so bucketing any finer than
/// this buys nothing.
pub const BEACON_BUCKET_MILLIS: i64 = 120_000;

/// The discovery anchor a beacon in `geohash` published during `bucket` is
/// linked from.
pub fn presence_anchor(geohash: &str, bucket: i64) -> String {
    format!("presence_geohash.{geohash}.{bucket}")
}

/// The bucket a beacon was published in, recovered from its own expiry
/// (always publish time + `BEACON_TTL_MILLIS`) -- deterministic, so
/// validation can check a beacon was linked under the right anchor.
pub fn beacon_bucket(beacon: &PresenceBeacon) -> i64 {
    relay_types::time_bucket(beacon.expires_at.as_millis() - BEACON_TTL_MILLIS, BEACON_BUCKET_MILLIS)
}

/// Precision for presence beacons: city-block scale, never per-GPS-tick.
/// Matches `catalog::CATALOG_GEOHASH_PRECISION` so both discovery paths share
/// one grid. Also duplicated as `dispatch_coordinator::matching::geo_presence_precision()`
/// (coordinator zomes can't depend on each other's crates, only call across
/// the zome-call boundary -- see that function's own doc comment) -- keep
/// both in sync if this ever changes.
pub const PRESENCE_GEOHASH_PRECISION: usize = 6;

/// Beacons are refreshed by the client every 45-60s and are read with a
/// client-side `expires_at` filter -- Holochain doesn't expire DHT entries on
/// its own, and going faster than this doesn't help: Kitsune2's own gossip
/// floor is roughly a minute, so a faster refresh can't propagate any faster
/// than the network already does.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct PresenceBeacon {
    pub provider: AgentPubKey,
    pub geohash: String,
    pub capabilities: Vec<DeliveryCapability>,
    pub expires_at: Timestamp,
}

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    PresenceBeacon(PresenceBeacon),
}

#[hdk_link_types]
pub enum LinkTypes {
    AgentToBeacon,
    GeohashToBeacon,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::PresenceBeacon(beacon) => validate_beacon(&beacon, action.author()),
        },
        FlatOp::CreateEntry(OpEntry::UpdateEntry { app_entry, action }) => match app_entry {
            EntryTypes::PresenceBeacon(beacon) => validate_beacon(&beacon, action.author()),
        },
        FlatOp::Link(OpLink::CreateLink { link_type, action }) => validate_create_link(link_type, &action.base_address, &action.target_address, action.author()),
        FlatOp::Link(OpLink::DeleteLink { original_action, action, .. }) => {
            require(original_action.author() == action.author(), "only a link's own author may delete it")
        }
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_beacon(beacon: &PresenceBeacon, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if &beacon.provider != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a provider can only publish a beacon for themselves".into(),
        ));
    }
    if beacon.geohash.chars().count() != PRESENCE_GEOHASH_PRECISION {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "geohash must be exactly {} characters",
            PRESENCE_GEOHASH_PRECISION
        )));
    }
    if beacon.capabilities.is_empty() {
        return Ok(ValidateCallbackResult::Invalid(
            "a beacon must declare at least one delivery capability".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// A provider may only link their own beacons -- under their own agent, or
/// under the discovery anchor for the beacon's own cell and publish bucket.
/// Otherwise anyone could make a provider appear online somewhere they
/// aren't (or flood a cell's anchor with someone else's beacons).
fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let record = match link_target(target)? {
        LinkTarget::Record(record) => record,
        LinkTarget::PathNode => return require(link_type == LinkTypes::GeohashToBeacon, "AgentToBeacon links must target a beacon"),
    };
    let Some(beacon) = decode::<PresenceBeacon>(&record) else { return invalid("target is not a PresenceBeacon") };
    let expected_base: AnyLinkableHash = match link_type {
        LinkTypes::AgentToBeacon => beacon.provider.clone().into(),
        LinkTypes::GeohashToBeacon => path_hash(presence_anchor(&beacon.geohash, beacon_bucket(&beacon)))?,
    };
    require(
        author == &beacon.provider && base == &expected_base,
        "a beacon may only be linked by its own provider, under them or its own cell's anchor for when it was published",
    )
}
