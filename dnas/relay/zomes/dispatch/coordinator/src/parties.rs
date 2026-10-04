//! Shared "who are this order's two active parties" resolution -- used by
//! both `chat.rs` and `tracking.rs`, the two signal-only, high-frequency
//! channels that only make sense once a bid has actually been accepted.
//! Factored out rather than duplicated a second time, now that a second
//! caller exists.

use dispatch_integrity::{Bid, DeliveryOrder};
use hdk::prelude::*;
use relay_coordinator_support::resolve_latest_decoded;

/// Resolves the order and its accepted bid. `unavailable_reason` becomes
/// the error message if no bid has been accepted yet -- callers each pass
/// their own wording (e.g. "chat is only available once a driver has been
/// assigned") rather than this helper imposing one generic message on every
/// caller.
pub fn resolve_order_and_bid(order_ref: ActionHash, unavailable_reason: &str) -> ExternResult<(DeliveryOrder, Bid)> {
    let (_, order): (_, DeliveryOrder) = resolve_latest_decoded(order_ref, "DeliveryOrder")?;
    let accepted_bid_ref = order
        .accepted_bid
        .clone()
        .ok_or(wasm_error!(WasmErrorInner::Guest(unavailable_reason.into())))?;
    let (_, bid): (_, Bid) = resolve_latest_decoded(accepted_bid_ref, "Bid")?;
    Ok((order, bid))
}
