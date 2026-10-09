//! Dispute-reference checks shared by both order verticals: an order's
//! `dispute_ref` must point at a real dispute about that order, and a
//! resolution must match the dispute's actual outcome.

use super::*;

/// Walks an action backward to the `Create` action that started its entry's
/// update chain. Needed because `Leg::order_ref` (as set by callers of
/// `attestation::record_leg`) is always the order's *original* creation
/// hash -- a stable identifier reused across the order's whole lifecycle --
/// while `validate_order_transition`'s `original_action_hash` is only the
/// *immediately preceding* action (it changes on every update). Mirrors
/// `relay_coordinator_support::resolve_latest`'s walk, just in the opposite
/// direction and via `hdi::must_get_valid_record` rather than `hdk`'s
/// `get_details`, since integrity zomes can't call coordinator-side hdk
/// functions.
pub(crate) fn resolve_original_creation(action_hash: ActionHash) -> ExternResult<ActionHash> {
    let record = must_get_valid_record(action_hash.clone())?;
    match &record.action().data {
        ActionData::Update(update) => resolve_original_creation(update.original_action_address.clone()),
        _ => Ok(action_hash),
    }
}

/// Checked when a `Disputed`-raising transition (`PickedUp`/`Delivered ->
/// Disputed`) sets `dispute_ref` for the first time: the referenced
/// `Dispute` must genuinely be a fresh, still-open case for *this* order,
/// raised by the same agent authoring this very order update (raising a
/// dispute is a two-call sequence -- `dispute::open_dispute` then this
/// order update -- and both calls execute in the same agent's context, so
/// they must agree on who raised it), and naming the order's actual *other*
/// party as respondent. `dispute_integrity`'s own validation deliberately
/// can't check this last part itself (it would need this order's *current*
/// mutable state, which isn't a deterministic fact from an unrelated entry's
/// perspective) -- this is the one place with correct temporal context
/// (`prior`/`expected_respondent`, both already resolved from the actual
/// transition being validated), so it's the one place this can be checked.
pub(crate) fn validate_new_dispute_ref(
    order_original_creation: &ActionHash,
    dispute_ref: &ActionHash,
    author: &AgentPubKey,
    expected_respondent: &AgentPubKey,
) -> ExternResult<Result<(), String>> {
    let dispute_record = must_get_valid_record(dispute_ref.clone())?;
    let Some(dispute): Option<Dispute> = dispute_record.entry().to_app_option().map_err(|e| wasm_error!(e))? else {
        return Ok(Err("dispute_ref does not point at a Dispute entry".into()));
    };
    if dispute.status != DisputeStatus::Open {
        return Ok(Err("dispute_ref must reference a still-Open dispute when first raised".into()));
    }
    if &dispute.raised_by != author {
        return Ok(Err("dispute_ref's raised_by must match the author of this order update".into()));
    }
    if &dispute.respondent != expected_respondent {
        return Ok(Err("dispute_ref's respondent must be the order's other party relative to raised_by".into()));
    }
    let dispute_order_creation = resolve_original_creation(dispute.order_ref)?;
    if &dispute_order_creation != order_original_creation {
        return Ok(Err("dispute_ref references a dispute belonging to a different order".into()));
    }
    Ok(Ok(()))
}

/// Checked on the two resolution transitions (`Disputed -> Delivered`/
/// `Cancelled`): the unchanged `dispute_ref` must point at a `Dispute` that
/// is actually `Resolved`, ruled by *this* update's own author (an
/// arbitrator can't apply another arbitrator's ruling), with an outcome
/// whose polarity matches the target status -- `FavorProvider` can only
/// land on `Delivered`, `FavorRequester` only on `Cancelled`.
pub(crate) fn validate_dispute_resolution_matches(dispute_ref: &ActionHash, target_status: &DeliveryStatus, author: &AgentPubKey) -> ExternResult<Result<(), String>> {
    let dispute_record = must_get_valid_record(dispute_ref.clone())?;
    let Some(dispute): Option<Dispute> = dispute_record.entry().to_app_option().map_err(|e| wasm_error!(e))? else {
        return Ok(Err("dispute_ref does not point at a Dispute entry".into()));
    };
    if dispute.status != DisputeStatus::Resolved {
        return Ok(Err("dispute_ref must reference a Resolved dispute before the order can leave Disputed".into()));
    }
    if dispute.arbitrator.as_ref() != Some(author) {
        return Ok(Err("the order update's author must be the same arbitrator who ruled on the dispute".into()));
    }
    let outcome_matches = match dispute.outcome {
        Some(DisputeOutcome::FavorProvider) => *target_status == DeliveryStatus::Delivered,
        Some(DisputeOutcome::FavorRequester) => *target_status == DeliveryStatus::Cancelled,
        None => false,
    };
    if !outcome_matches {
        return Ok(Err("the target status does not match the dispute's ruled outcome".into()));
    }
    Ok(Ok(()))
}

/// The cancellation-fairness equivalent of `validate_dispute_resolution_matches`
/// (architecture plan §11.1) -- no outcome/target-status polarity check,
/// since the order's status never changes here (already `Cancelled`, stays
/// `Cancelled` either way); only that the referenced dispute is genuinely
/// `Resolved` and ruled by this update's own author. This is also what
/// closes a real replay gap: without *some* validate()-enforced,
/// one-time-only state change gating `apply_cancellation_dispute_resolution`,
/// nothing would stop the winning party (who is legitimately "a party" to
/// the resulting ledger transaction, so `ledger_integrity`'s own check
/// alone wouldn't catch it) from calling it repeatedly to multiply the
/// forfeiture. Requiring `dispute_ref` to advance here, exactly once,
/// closes that the same way the original design already closes it for
/// `Disputed -> Delivered/Cancelled`.
pub(crate) fn validate_cancellation_dispute_resolution_matches(dispute_ref: &ActionHash, author: &AgentPubKey) -> ExternResult<Result<(), String>> {
    let dispute_record = must_get_valid_record(dispute_ref.clone())?;
    let Some(dispute): Option<Dispute> = dispute_record.entry().to_app_option().map_err(|e| wasm_error!(e))? else {
        return Ok(Err("dispute_ref does not point at a Dispute entry".into()));
    };
    if dispute.status != DisputeStatus::Resolved {
        return Ok(Err("dispute_ref must reference a Resolved dispute before its resolution can be applied".into()));
    }
    if dispute.arbitrator.as_ref() != Some(author) {
        return Ok(Err("the order update's author must be the same arbitrator who ruled on the dispute".into()));
    }
    Ok(Ok(()))
}
