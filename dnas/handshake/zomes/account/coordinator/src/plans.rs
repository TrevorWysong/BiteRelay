//! Recovery plans, and the guardians they name.

use crate::{decoded, guest, linked_records, me, own_links};
use account_integrity::*;
use hdk::prelude::*;

/// A plan, with the action that published it.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlanView {
    pub plan: ActionHash,
    pub account: AgentPubKey,
    pub phrase_key: Option<AgentPubKey>,
    pub guardians: Vec<AgentPubKey>,
    pub threshold: u8,
    pub published_at: Timestamp,
}

fn view_of(record: &Record) -> Option<PlanView> {
    let plan = decoded::<RecoveryPlan>(record)?;
    Some(PlanView {
        plan: record.action_address().clone(),
        account: record.action().author().clone(),
        phrase_key: plan.phrase_key,
        guardians: plan.guardians,
        threshold: plan.threshold,
        published_at: record.action().timestamp(),
    })
}

/// Publishes the caller's recovery plan, replacing any before it.
#[hdk_extern]
pub fn set_recovery_plan(plan: RecoveryPlan) -> ExternResult<PlanView> {
    let me = me()?;
    let hash = create_entry(&EntryTypes::RecoveryPlan(plan.clone()))?;
    create_link(me, hash.clone(), LinkTypes::AccountToPlan, ())?;
    if let Some(key) = &plan.phrase_key {
        create_link(key.clone(), hash.clone(), LinkTypes::PhraseKeyToPlan, ())?;
    }
    for guardian in &plan.guardians {
        create_link(guardian.clone(), hash.clone(), LinkTypes::GuardianToPlan, ())?;
    }
    let record = handshake_coordinator_support::written(hash)?;
    view_of(&record).ok_or(guest("couldn't read the plan back"))
}

/// How far an account's chain may run past its recovery plan before its app
/// re-affirms the plan. Recovering the account walks its chain from where
/// it stands back to the plan (`account_integrity::plan_as_of`), so this
/// bounds what any recovery costs to validate, however long the account
/// has been in use.
pub const REAFFIRM_AFTER_ACTIONS: u32 = 2_000;

/// Publishes the caller's plan again, unchanged, once their chain has run
/// `REAFFIRM_AFTER_ACTIONS` past it -- never once the account has been
/// taken over, since a recovery stands on the plan it was made under.
/// Whether it did. The app calls it from time to time.
#[hdk_extern]
pub fn reaffirm_recovery_plan(_: ()) -> ExternResult<bool> {
    let mine = crate::my_linked(LinkTypes::AccountToPlan)?;
    let Some(latest) = mine.iter().max_by_key(|r| r.action().action_seq()) else { return Ok(false) };
    let (_, head_seq, _) = agent_info()?.chain_head;
    if head_seq.saturating_sub(latest.action().action_seq()) < REAFFIRM_AFTER_ACTIONS {
        return Ok(false);
    }
    if !crate::succession::successions_of(me()?)?.is_empty() {
        return Ok(false);
    }
    let Some(plan) = decoded::<RecoveryPlan>(latest) else { return Ok(false) };
    set_recovery_plan(plan)?;
    Ok(true)
}

/// The caller's current plan, if they've published one.
#[hdk_extern]
pub fn my_recovery_plan(_: ()) -> ExternResult<Option<PlanView>> {
    Ok(crate::my_linked(LinkTypes::AccountToPlan)?.iter().max_by_key(|r| r.action().action_seq()).and_then(view_of))
}

/// `account`'s current plan, as far as the network has seen.
#[hdk_extern]
pub fn recovery_plan_of(account: AgentPubKey) -> ExternResult<Option<PlanView>> {
    Ok(linked_records(own_links(&account, LinkTypes::AccountToPlan)?, GetStrategy::default())?
        .iter()
        .max_by_key(|r| r.action().action_seq())
        .and_then(view_of))
}

/// The accounts a recovery phrase's key recovers: those whose current plan
/// names it.
#[hdk_extern]
pub fn accounts_for_phrase_key(key: AgentPubKey) -> ExternResult<Vec<PlanView>> {
    let mut accounts = Vec::new();
    for record in linked_records(LinkQuery::try_new(key.clone(), LinkTypes::PhraseKeyToPlan)?, GetStrategy::default())? {
        let Some(view) = view_of(&record) else { continue };
        if view.phrase_key.as_ref() != Some(&key) || accounts.iter().any(|a: &PlanView| a.account == view.account) {
            continue;
        }
        // Only a plan still in force: a phrase the person replaced recovers
        // nothing.
        if recovery_plan_of(view.account.clone())?.is_some_and(|current| current.plan == view.plan) {
            accounts.push(view);
        }
    }
    Ok(accounts)
}

/// The accounts the caller guards: those whose current plan names them.
#[hdk_extern]
pub fn my_wards(_: ()) -> ExternResult<Vec<PlanView>> {
    let me = me()?;
    let mut wards: Vec<PlanView> = Vec::new();
    for record in linked_records(LinkQuery::try_new(me.clone(), LinkTypes::GuardianToPlan)?, GetStrategy::default())? {
        let Some(view) = view_of(&record) else { continue };
        if wards.iter().any(|w| w.account == view.account) {
            continue;
        }
        if let Some(current) = recovery_plan_of(view.account.clone())? {
            if current.guardians.contains(&me) {
                wards.push(current);
            }
        }
    }
    Ok(wards)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct VouchInput {
    pub account: AgentPubKey,
    /// The key they're recovering onto, from their new device.
    pub successor: AgentPubKey,
}

/// The caller, a guardian, vouching that `successor` is the person behind
/// `account` -- once per account and plan. Safe to repeat for the same key.
#[hdk_extern]
pub fn vouch(input: VouchInput) -> ExternResult<ActionHash> {
    let me = me()?;
    let plan = recovery_plan_of(input.account.clone())?.ok_or(guest("That account has no recovery plan."))?;
    if !plan.guardians.contains(&me) {
        return Err(guest("You aren't one of this account's guardians."));
    }
    // Once per account and plan -- validation's rule, read back as far as
    // it does: to when the plan was published.
    let mine = handshake_coordinator_support::chain::mine(&[EntryType::try_from(UnitEntryTypes::Vouch)?]).since(plan.published_at).records()?;
    for record in &mine {
        let Some(earlier) = decoded::<Vouch>(record) else { continue };
        if earlier.account == input.account && earlier.plan == plan.plan {
            return if earlier.successor == input.successor {
                Ok(record.action_address().clone())
            } else {
                Err(guest("You've already vouched for another key for this account."))
            };
        }
    }
    let hash = create_entry(&EntryTypes::Vouch(Vouch { account: input.account, successor: input.successor.clone(), plan: plan.plan }))?;
    create_link(input.successor, hash.clone(), LinkTypes::SuccessorToVouch, ())?;
    Ok(hash)
}

/// A guardian's vouch for the caller.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VouchView {
    pub vouch: ActionHash,
    pub guardian: AgentPubKey,
    pub account: AgentPubKey,
    pub plan: ActionHash,
}

/// Every vouch for the caller's key, from any guardian.
#[hdk_extern]
pub fn vouches_for_me(_: ()) -> ExternResult<Vec<VouchView>> {
    let me = me()?;
    Ok(linked_records(LinkQuery::try_new(me.clone(), LinkTypes::SuccessorToVouch)?, GetStrategy::default())?
        .iter()
        .filter_map(|record| {
            let vouch = decoded::<Vouch>(record)?;
            (vouch.successor == me).then(|| VouchView { vouch: record.action_address().clone(), guardian: record.action().author().clone(), account: vouch.account, plan: vouch.plan })
        })
        .collect())
}
