//! Live driver-location sharing during an active delivery -- signal-only,
//! same reasoning as `chat.rs`: a GPS ping is the highest-frequency,
//! lowest-long-term-value data this app could ever produce, so persisting
//! it to the DHT would repeat the presence-beacon unbounded-growth mistake
//! architecture plan §9.1 already named and fixed, except worse (beacons
//! refresh every 45-60s; live tracking is meant to update every few
//! seconds). There is deliberately no entry type here at all.
//!
//! Unlike chat, this channel is one-directional: only the assigned
//! driver's position is meaningful to the customer, never the reverse, so
//! only the order's accepted bidder may call this, and it always targets
//! the requester. Rate limiting (how often the driver's own client
//! actually calls this) is a client-side discipline, not enforced here --
//! the same posture this app already takes with presence-beacon refresh
//! cadence (plan §3): nothing here can deterministically rate-limit a
//! signal, so the client is responsible for not calling this faster than
//! genuinely useful (a few seconds, not sub-second).

use crate::parties::resolve_order_and_bid;
use crate::signals::RemoteSignal;
use hdk::prelude::*;
use relay_coordinator_support::guest;

#[derive(Serialize, Deserialize, Debug)]
pub struct SendLocationUpdateInput {
    pub order_ref: ActionHash,
    pub lat: f64,
    pub lon: f64,
}

#[hdk_extern]
pub fn send_location_update(input: SendLocationUpdateInput) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    let (order, bid) = resolve_order_and_bid(
        input.order_ref.clone(),
        "live location sharing is only available once a driver has been assigned",
    )?;
    if me != bid.bidder {
        return Err(guest("Only this order's driver can share a live location."));
    }
    send_remote_signal(
        RemoteSignal::LocationUpdate { order_hash: input.order_ref, lat: input.lat, lon: input.lon },
        vec![order.requester],
    )
}
