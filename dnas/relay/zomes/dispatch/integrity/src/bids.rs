//! Bid validation: who may bid on an order, and what a bid update may change.

use super::*;

pub(crate) fn validate_new_bid(bid: &Bid, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if &bid.bidder != author {
        return Ok(ValidateCallbackResult::Invalid("a bid can only be authored by its own bidder".into()));
    }
    if bid.eta_seconds == 0 {
        return Ok(ValidateCallbackResult::Invalid("eta_seconds must be greater than zero".into()));
    }
    if bid.price_offer == 0 {
        return Ok(ValidateCallbackResult::Invalid("price_offer must be greater than zero".into()));
    }
    if bid.status != BidStatus::Open {
        return Ok(ValidateCallbackResult::Invalid("a new bid must start in the Open status".into()));
    }
    let record = must_get_valid_record(bid.order_ref.clone())?;
    let order: DeliveryOrder = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "order_ref does not point at a DeliveryOrder entry".into()
        )))?;
    if order.status != DeliveryStatus::Open {
        return Ok(ValidateCallbackResult::Invalid("bids can only be placed on an Open order".into()));
    }
    if bid.collateral != required_collateral(&order) {
        return Ok(ValidateCallbackResult::Invalid("a bid must commit the order's required collateral: the value of its food".into()));
    }
    // Otherwise unenforced self-dealing: nothing else stops the requester or
    // merchant from bidding on (and accepting) their own order -- the first
    // symptom wouldn't be here, it'd be a much later, far more confusing
    // `InvalidCommit` at pickup-confirmation time, when `record_leg` tries to
    // create a Leg with identical `from`/`to` agents. Reject it here instead,
    // at the earliest point it's actually knowable, with a clear reason.
    if bid.bidder == order.requester {
        return Ok(ValidateCallbackResult::Invalid(
            "a requester cannot bid to deliver their own order".into(),
        ));
    }
    if bid.bidder == order.merchant {
        return Ok(ValidateCallbackResult::Invalid(
            "a merchant cannot bid to deliver their own order".into(),
        ));
    }
    if let Some(max_fee) = order.max_delivery_fee {
        if bid.price_offer > max_fee {
            return Ok(ValidateCallbackResult::Invalid(
                "price_offer exceeds the order's max_delivery_fee".into(),
            ));
        }
    }
    Ok(ValidateCallbackResult::Valid)
}

/// A bid only ever changes by its bidder withdrawing it -- the order's
/// requester accepts a bid by updating the *order*, not the bid. So an
/// update must be the bidder's, of their own Open bid, changing nothing but
/// its status to Withdrawn.
pub(crate) fn validate_bid_update(bid: &Bid, author: &AgentPubKey, original: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let prior_record = must_get_valid_record(original.clone())?;
    let Ok(Some(prior)) = prior_record.entry().to_app_option::<Bid>() else {
        return Ok(ValidateCallbackResult::Invalid("original_action_hash does not point at a Bid entry".into()));
    };
    if prior_record.action().author() != author || &prior.bidder != author {
        return Ok(ValidateCallbackResult::Invalid("only the bidder may update their own bid".into()));
    }
    if prior.status != BidStatus::Open || bid.status != BidStatus::Withdrawn {
        return Ok(ValidateCallbackResult::Invalid("a bidder may only withdraw an open bid".into()));
    }
    let unchanged = Bid { status: BidStatus::Withdrawn, ..prior } == *bid;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid("withdrawing a bid may only change its status".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}
