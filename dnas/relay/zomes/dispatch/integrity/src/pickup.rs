//! Pickup-order validation: creation, its own (driverless) status state
//! machine, and pickup disputes.

use super::*;
use crate::disputes::*;

/// `PickupOrder`'s sibling of `validate_new_order` -- same shape, minus
/// every check that only makes sense once a driver is in the loop
/// (dropoff/geohash, accepted_bid, delivery_receipts all simply don't
/// exist on this entry type at all, so there's nothing to check there).
pub(crate) fn validate_new_pickup_order(order: &PickupOrder, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if &order.requester != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a pickup order can only be authored by its own requester".into(),
        ));
    }
    if order.item_refs.is_empty() {
        return Ok(ValidateCallbackResult::Invalid("an order must reference at least one item".into()));
    }
    if order.order_total == 0 {
        return Ok(ValidateCallbackResult::Invalid("order_total must be greater than zero".into()));
    }
    if order.status != PickupStatus::Placed {
        return Ok(ValidateCallbackResult::Invalid("a new pickup order must start Placed".into()));
    }
    if order.dispute_ref.is_some() {
        return Ok(ValidateCallbackResult::Invalid("a new pickup order cannot already have a dispute_ref".into()));
    }
    if let Some(reason) = check_merchant_owns_catalog(&order.merchant, &order.catalog_ref)? {
        return Ok(ValidateCallbackResult::Invalid(reason));
    }
    // promo_code_ref check deliberately omitted from this first pass --
    // see validate_new_order's own doc comment for the full reasoning on
    // why this is coordinator-level/best-effort anyway; wiring promo
    // support into pickup orders is a separate, later addition, not part
    // of this entry type's initial shape.
    //
    // bag_claim_ref *is* checked here, symmetrically with validate_new_order's
    // own check -- same reasoning, "claimed for pickup" instead of delivery,
    // and the same "can't check `status` deterministically" exemption (see
    // validate_new_order's own doc comment for why -- `must_get_valid_record`
    // is literal, and `status` is exactly the field `confirm_claim` updates).
    // Named gap shared by both order types, not solved here: nothing stops
    // the same Confirmed claim from being spent on two separate orders (no
    // claim -> order back-link exists to detect that). Same honestly-named
    // trust tier as `confirm_claim`'s own re-derived quantity_total count --
    // low-stakes (at most a merchant over-delivers one extra bag's worth of
    // food, no money moves twice, since each resulting order still settles
    // its own independently-authored order_total), not worth a new link
    // type/redeemed-flag mechanism for this first pass.
    if let Some(claim_ref) = &order.bag_claim_ref {
        let claim_record = must_get_valid_record(claim_ref.clone())?;
        let claim: BagClaim = claim_record
            .entry()
            .to_app_option()
            .map_err(|e| wasm_error!(e))?
            .ok_or(wasm_error!(WasmErrorInner::Guest(
                "bag_claim_ref does not point at a BagClaim entry".into()
            )))?;
        if claim.customer != order.requester {
            return Ok(ValidateCallbackResult::Invalid(
                "bag_claim_ref's own customer must match this order's requester".into(),
            ));
        }
        if claim.fulfillment != BagClaimFulfillment::Pickup {
            return Ok(ValidateCallbackResult::Invalid(
                "bag_claim_ref was not claimed for pickup".into(),
            ));
        }
    }
    Ok(ValidateCallbackResult::Valid)
}

/// `PickupOrder`'s sibling of `check_raising_dispute`/`check_resolving_dispute`
/// -- much simpler, since there are only ever two parties (requester,
/// merchant) and no accepted-bidder derivation needed: whichever of the two
/// didn't author this update is the respondent.
pub(crate) fn pickup_other_party(order: &PickupOrder, author: &AgentPubKey) -> AgentPubKey {
    if author == &order.requester {
        order.merchant.clone()
    } else {
        order.requester.clone()
    }
}

pub(crate) fn check_raising_pickup_dispute(
    prior: &PickupOrder,
    order: &PickupOrder,
    author: &AgentPubKey,
    original_action_hash: &ActionHash,
) -> ExternResult<Result<(), String>> {
    if prior.dispute_ref.is_some() {
        return Ok(Err("dispute_ref must be empty before a dispute is first raised".into()));
    }
    let Some(new_dispute_ref) = &order.dispute_ref else {
        return Ok(Err("raising a dispute must set dispute_ref".into()));
    };
    let expected_respondent = pickup_other_party(prior, author);
    let order_original_creation = resolve_original_creation(original_action_hash.clone())?;
    validate_new_dispute_ref(&order_original_creation, new_dispute_ref, author, &expected_respondent)
}

pub(crate) fn check_resolving_pickup_dispute(prior: &PickupOrder, order: &PickupOrder, author: &AgentPubKey) -> ExternResult<Result<(), String>> {
    let Some(prior_dispute_ref) = &prior.dispute_ref else {
        return Ok(Err("a Disputed order with no dispute_ref cannot be resolved".into()));
    };
    let Some(new_dispute_ref) = &order.dispute_ref else {
        return Ok(Err("resolving a dispute must set dispute_ref to the resolved record".into()));
    };
    let new_dispute_original_creation = resolve_original_creation(new_dispute_ref.clone())?;
    if &new_dispute_original_creation != prior_dispute_ref {
        return Ok(Err("dispute_ref update must resolve back to the same dispute originally raised".into()));
    }
    // PickupOrder has no delivery-fee-split/FavorProvider-means-driver
    // concept -- "Provider" is reinterpreted as "merchant" here, the only
    // other party there is. validate_dispute_resolution_matches itself is
    // generic over target status, not over DeliveryStatus specifically, so
    // it's reused as-is: FavorProvider -> PickedUp (the merchant's side
    // wins, order completes), FavorRequester -> Cancelled.
    let target = match order.status {
        PickupStatus::PickedUp => DeliveryStatus::Delivered,
        PickupStatus::Cancelled => DeliveryStatus::Cancelled,
        _ => return Ok(Err("resolving a pickup dispute must target PickedUp or Cancelled".into())),
    };
    validate_dispute_resolution_matches(new_dispute_ref, &target, author)
}

pub(crate) fn validate_pickup_order_transition(
    order: &PickupOrder,
    author: &AgentPubKey,
    original_action_hash: &ActionHash,
) -> ExternResult<ValidateCallbackResult> {
    let prior_record = must_get_valid_record(original_action_hash.clone())?;
    let prior: PickupOrder = prior_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "original_action_hash does not point at a PickupOrder entry".into()
        )))?;

    let Some(required_author) = prior.status.transition_requirement(&order.status) else {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "illegal status transition: {:?} -> {:?}",
            prior.status, order.status
        )));
    };

    let is_requester_or_merchant = &prior.requester == author || &prior.merchant == author;
    let authorized = match required_author {
        RequiredAuthor::RequesterOrMerchant => is_requester_or_merchant,
        RequiredAuthor::Any => is_requester_or_merchant,
        RequiredAuthor::Arbitrator => relay_governance::is_arbitrator(author)?,
        // Never produced by PickupStatus::transition_requirement -- there is
        // no accepted-provider concept at all for this entry type.
        RequiredAuthor::AcceptedProvider => false,
    };
    if !authorized {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "transition {:?} -> {:?} requires author role {:?}, but the author holds none of the roles it permits",
            prior.status, order.status, required_author
        )));
    }

    let raising_dispute = matches!(prior.status, PickupStatus::ReadyForPickup | PickupStatus::PickedUp) && order.status == PickupStatus::Disputed;
    let resolving_dispute = prior.status == PickupStatus::Disputed && matches!(order.status, PickupStatus::PickedUp | PickupStatus::Cancelled);
    if raising_dispute {
        if let Err(reason) = check_raising_pickup_dispute(&prior, order, author, original_action_hash)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if resolving_dispute {
        if let Err(reason) = check_resolving_pickup_dispute(&prior, order, author)? {
            return Ok(ValidateCallbackResult::Invalid(reason));
        }
    } else if prior.dispute_ref != order.dispute_ref {
        return Ok(ValidateCallbackResult::Invalid(
            "dispute_ref may only change when a dispute is raised or resolved".into(),
        ));
    }

    let unchanged = prior.requester == order.requester
        && prior.merchant == order.merchant
        && prior.catalog_ref == order.catalog_ref
        && prior.item_refs == order.item_refs
        && prior.order_total == order.order_total
        && prior.requested_at == order.requested_at
        && prior.special_instructions == order.special_instructions
        && prior.promo_code_ref == order.promo_code_ref
        && prior.bag_claim_ref == order.bag_claim_ref;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "a pickup order update may only change status/dispute_ref -- every other field must stay the same".into(),
        ));
    }

    Ok(ValidateCallbackResult::Valid)
}
