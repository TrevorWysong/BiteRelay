//! Chat and live driver location: what an order's customer and its driver
//! tell each other while it's under way. Neither is ever written down -- a
//! chat line is lower-stakes than anything this app stores, and a GPS ping
//! every few seconds would grow a driver's chain without bound for data
//! nobody needs once the order's done. So no history survives a reload:
//! an honest, named limitation, not an oversight.
//!
//! Both travel as Holochain direct signals, app to app, with no zome code
//! on either end (the app's `holochain/live.ts`). The network vouches for
//! who sent one; what it can't know is whether the sender is on the order.
//! That's this extern: each end asks once who its counterpart is, then
//! checks every signal it sends or receives against the answer.
//!
//! Each device grants direct signals in `prepare_device` (signals.rs).

use crate::signals::OrderRole;
use dispatch_integrity::{Bid, DeliveryOrder};
use hdk::prelude::*;
use relay_coordinator_support::{guest, resolve_latest_decoded};

/// The other active party on an order, and which side the caller is on.
#[derive(Serialize, Deserialize, Debug)]
pub struct LiveCounterpart {
    pub counterpart: AgentPubKey,
    /// `Customer` or `Driver`: only the driver shares a location, and only
    /// the customer hears one.
    pub role: OrderRole,
}

/// Who the caller talks to about `order_ref` -- the driver whose bid was
/// accepted if they're its customer, its customer if they're that driver.
/// There's no third party (the store) on this channel.
#[hdk_extern]
pub fn live_counterpart(order_ref: ActionHash) -> ExternResult<LiveCounterpart> {
    let me = agent_info()?.agent_initial_pubkey;
    let (_, order): (_, DeliveryOrder) = resolve_latest_decoded(order_ref, "DeliveryOrder")?;
    let bid_ref = order.accepted_bid.ok_or(guest("This order has no driver yet."))?;
    let (_, bid): (_, Bid) = resolve_latest_decoded(bid_ref, "Bid")?;
    if me == order.requester {
        Ok(LiveCounterpart { counterpart: bid.bidder, role: OrderRole::Customer })
    } else if me == bid.bidder {
        Ok(LiveCounterpart { counterpart: order.requester, role: OrderRole::Driver })
    } else {
        Err(guest("Only this order's customer and its driver can chat about it."))
    }
}
