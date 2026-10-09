//! Rules both order types share about the store's answer: how long it has
//! to accept an order, when it says the order will be ready, and who may
//! cancel one and for what reason.

use super::*;
use relay_governance::store_response_window;

/// One update to an order, as these rules need it.
pub(crate) struct OrderUpdate<'a> {
    pub requester: &'a AgentPubKey,
    pub merchant: &'a AgentPubKey,
    pub author: &'a AgentPubKey,
    /// When the version being updated was written -- for an order waiting on
    /// its store, when it reached the store.
    pub prior_written_at: Timestamp,
    /// When this update was written. Its own recorded timestamp, so every
    /// validator reaches the same answer.
    pub written_at: Timestamp,
}

impl OrderUpdate<'_> {
    /// Whether the store's window to accept the order, which opened when the
    /// order reached it, is still open at this update.
    pub fn within_response_window(&self) -> bool {
        let elapsed_micros = self.written_at.as_micros() - self.prior_written_at.as_micros();
        elapsed_micros < store_response_window().as_micros() as i64
    }
}

/// Where an order being cancelled was cancelled from, as far as these rules
/// care.
#[derive(PartialEq, Eq)]
pub(crate) enum CancelledFrom {
    /// Waiting for the store to accept it.
    Placed,
    /// Under dispute -- only an arbitrator's ruling cancels it from here.
    Disputed,
    Elsewhere,
}

/// `cancellation` across one update: written once, by the update that
/// cancels the order (`cancelled_from` is `Some` exactly then), with a
/// reason its author can give -- and never changed after. `None` if valid,
/// else why not.
pub(crate) fn check_cancellation(update: &OrderUpdate<'_>, cancelled_from: Option<CancelledFrom>, prior: &Option<Cancellation>, next: &Option<Cancellation>) -> Option<String> {
    let Some(from) = cancelled_from else {
        return (prior != next).then(|| "an order's cancellation is set once, by the update that cancels it".into());
    };
    let Some(reason) = next else {
        return Some("cancelling an order must say why".into());
    };
    let allowed = match reason {
        _ if from == CancelledFrom::Disputed => *reason == Cancellation::ByArbitrator,
        Cancellation::ByCustomer => update.author == update.requester,
        Cancellation::ByStore(_) => update.author == update.merchant,
        Cancellation::StoreDidNotRespond => update.author == update.requester && from == CancelledFrom::Placed && !update.within_response_window(),
        Cancellation::ByArbitrator => false,
    };
    (!allowed).then(|| format!("{reason:?} isn't a cancellation this author can give here"))
}

/// The longest a store may say an order will take.
const MAX_READY_MICROS: i64 = 240 * 60 * 1_000_000;

/// `ready_by` across one update: set when the store accepts the order
/// (`accepting`), to a time after the acceptance and within the longest a
/// kitchen may promise, and never changed after. `None` if valid.
pub(crate) fn check_ready_by(update: &OrderUpdate<'_>, accepting: bool, prior: Option<Timestamp>, next: Option<Timestamp>) -> Option<&'static str> {
    if !accepting {
        return (prior != next).then_some("ready_by is set once, when the store accepts the order");
    }
    match next {
        Some(ready_by) if ready_by > update.written_at && ready_by.as_micros() - update.written_at.as_micros() <= MAX_READY_MICROS => None,
        _ => Some("accepting an order must say when it'll be ready, within four hours"),
    }
}
