//! Integrity zome for `PresenceBeacon` -- a short-lived, coarse (city-block
//! precision) provider-location claim. Deliberately never carries real-time
//! GPS; see the coordinator crate for the refresh-cadence reasoning.

use hdi::prelude::*;
use relay_types::DeliveryCapability;

/// Precision for presence beacons: city-block scale, never per-GPS-tick.
/// Matches `catalog::CATALOG_GEOHASH_PRECISION` so both discovery paths share
/// one grid.
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
