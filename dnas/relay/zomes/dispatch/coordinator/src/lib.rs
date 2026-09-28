//! Coordinator zome for the delivery order lifecycle: matching a new order
//! to nearby providers, bidding, and the gated path to completion (payment
//! + reputation). Split by concern rather than kept as one flat file:
//!
//! - `signals` -- the capability grant and local/remote signal wire types
//!   everything else here sends over.
//! - `matching` -- Layers 1/2 of the matching mechanism (plan §3): the
//!   geohash anchor, the cross-zome candidate lookup, the signal fan-out.
//! - `bids` -- placing, withdrawing, and accepting bids.
//! - `orders` -- the order itself: creation, status transitions, and the
//!   gated completion path that settles payment and reputation.
//! - `disputes` -- raising a dispute and applying an arbitrator's
//!   resolution (plan §8).

mod bids;
mod disputes;
mod matching;
mod orders;
mod signals;

pub use bids::*;
pub use disputes::*;
pub use matching::get_open_orders_near;
pub use orders::*;
pub use signals::*;
