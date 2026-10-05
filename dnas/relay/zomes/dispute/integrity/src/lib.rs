//! Integrity zome for dispute cases over whether a delivery was actually
//! completed properly -- see `dispute_types::Dispute`'s doc comment for
//! scope (only `PickedUp`/`Delivered -> Disputed` orders; cancellation-
//! fairness disputes and contested warrants are separate, undesigned gaps).
//! Resolution authorization (`relay_governance::is_arbitrator`) is this
//! zome's other half -- see architecture plan §8 for why a small, fixed,
//! DNA-properties-baked roster is the deliberate, named centralization
//! point here rather than a decentralized jury.

use dispatch_types::{DeliveryOrder, PickupOrder};
use hdi::prelude::*;

pub use dispute_types::{Dispute, DisputeOutcome, DisputeReason, DisputeStatus};

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    Dispute(Dispute),
}

#[hdk_link_types]
pub enum LinkTypes {
    OrderToDispute,
    OpenDisputeAnchor,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::Dispute(dispute) => validate_new_dispute(&dispute, action.author()),
        },
        FlatOp::CreateEntry(OpEntry::UpdateEntry { app_entry, action }) => match app_entry {
            EntryTypes::Dispute(dispute) => validate_resolution(&dispute, action.author(), &action.original_action_address),
        },
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_new_dispute(dispute: &Dispute, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if &dispute.raised_by != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a dispute can only be authored by its own raised_by agent".into(),
        ));
    }
    if dispute.raised_by == dispute.respondent {
        return Ok(ValidateCallbackResult::Invalid(
            "raised_by and respondent must be different agents".into(),
        ));
    }
    if dispute.status != DisputeStatus::Open {
        return Ok(ValidateCallbackResult::Invalid("a new dispute must start in the Open status".into()));
    }
    if dispute.outcome.is_some() || dispute.arbitrator.is_some() || dispute.reasoning.is_some() || dispute.resolved_at.is_some() {
        return Ok(ValidateCallbackResult::Invalid(
            "a new dispute cannot already carry a resolution".into(),
        ));
    }

    // `dispute.order_ref` is the order's *original creation* hash (a stable
    // identifier reused across its whole lifecycle -- see `dispatch::raise_dispute`/
    // `raise_pickup_dispute`), and `must_get_valid_record` is
    // deterministic-but-literal: it can only ever return that record *as
    // created* (status `Open`/`Placed`, no accepted bid), never the order's
    // current mutable state. So this only checks that `order_ref` genuinely
    // points at *some* order entry -- either vertical, `DeliveryOrder` or
    // `PickupOrder` (a `Dispute` is generic over which one; see
    // `DisputeOutcome`'s own doc comment) -- it deliberately does NOT
    // re-derive "is this order currently PickedUp or Delivered" or "is
    // raised_by really the accepted provider," since neither is a
    // deterministic fact from this entry's own perspective (an hdi
    // `validate()` callback has no way to safely ask "what is the *latest*
    // state of this other chain," only "what did this specific action look
    // like"). That check already happens correctly, with the right temporal
    // context, in `dispatch_integrity::validate_order_transition`/
    // `validate_pickup_order_transition` (`validate_new_dispute_ref`) when
    // the order itself transitions to `Disputed` -- this only guards against
    // obviously malformed disputes.
    let order_record = must_get_valid_record(dispute.order_ref.clone())?;
    let is_delivery_order = matches!(order_record.entry().to_app_option::<DeliveryOrder>(), Ok(Some(_)));
    let is_pickup_order = matches!(order_record.entry().to_app_option::<PickupOrder>(), Ok(Some(_)));
    if !is_delivery_order && !is_pickup_order {
        return Ok(ValidateCallbackResult::Invalid(
            "order_ref does not point at a DeliveryOrder or PickupOrder entry".into(),
        ));
    }

    for evidence_ref in &dispute.evidence_refs {
        must_get_valid_record(evidence_ref.clone())?;
    }

    Ok(ValidateCallbackResult::Valid)
}

fn validate_resolution(
    dispute: &Dispute,
    author: &AgentPubKey,
    original_action_hash: &ActionHash,
) -> ExternResult<ValidateCallbackResult> {
    let prior_record = must_get_valid_record(original_action_hash.clone())?;
    let Ok(Some(prior)) = prior_record.entry().to_app_option::<Dispute>() else {
        return Ok(ValidateCallbackResult::Invalid("original_action_hash does not point at a Dispute entry".into()));
    };
    if prior.status != DisputeStatus::Open {
        return Ok(ValidateCallbackResult::Invalid("only an Open dispute can be resolved".into()));
    }
    if dispute.status != DisputeStatus::Resolved {
        return Ok(ValidateCallbackResult::Invalid("a dispute update must resolve it".into()));
    }
    if dispute.outcome.is_none() || dispute.reasoning.is_none() || dispute.resolved_at.is_none() {
        return Ok(ValidateCallbackResult::Invalid(
            "a resolution must set outcome, reasoning, and resolved_at".into(),
        ));
    }
    if !relay_governance::is_arbitrator(author)? {
        return Ok(ValidateCallbackResult::Invalid(
            "a dispute can only be resolved by an agent on the arbitrator roster".into(),
        ));
    }
    if dispute.arbitrator.as_ref() != Some(author) {
        return Ok(ValidateCallbackResult::Invalid(
            "arbitrator must equal the actual author of the resolution -- an arbitrator cannot rule under another arbitrator's name".into(),
        ));
    }

    let unchanged = prior.order_ref == dispute.order_ref
        && prior.raised_by == dispute.raised_by
        && prior.respondent == dispute.respondent
        && prior.reason == dispute.reason
        && prior.description == dispute.description
        && prior.evidence_refs == dispute.evidence_refs
        && prior.raised_at == dispute.raised_at;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "a resolution may only change status, outcome, arbitrator, reasoning, and resolved_at -- every other field must stay the same".into(),
        ));
    }

    Ok(ValidateCallbackResult::Valid)
}
