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
//! - `chat` -- direct, signal-only messaging between an order's two active
//!   parties once a bid is accepted. Deliberately not persisted on the DHT
//!   (see that module's own doc comment).
//! - `tracking` -- live driver-location sharing, same signal-only,
//!   not-persisted posture as `chat`, but one-directional (driver ->
//!   requester only).
//! - `parties` -- the "resolve this order's accepted bid" lookup shared by
//!   `chat` and `tracking`, not itself a zome-call surface.

mod bids;
mod chat;
mod disputes;
mod matching;
mod orders;
mod parties;
mod signals;
mod tracking;

pub use bids::*;
pub use chat::*;
pub use disputes::*;
pub use matching::get_open_orders_near;
pub use orders::*;
pub use signals::*;
pub use tracking::*;
