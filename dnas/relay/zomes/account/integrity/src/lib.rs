//! Integrity zome for accounts: carrying someone's account on to a new key
//! when they move device or lose their old one. See `account_types` for
//! the model.
//!
//! What validation guarantees:
//!
//! - **Only a real authority passes an account on.** A key takes over an
//!   account (`Succession`) on the old key's own hand-over, on a signature
//!   by the recovery phrase's key, or on enough of its guardians' vouches --
//!   each checked against the plan the account itself published, its latest
//!   as of where the account stood. Nobody can claim someone else's account
//!   on their own say-so.
//! - **A guardian vouches once** for each account and plan, from their own
//!   chain, and never for themselves.
//! - **A key takes over at most one account**, so an account's history is a
//!   single line of keys.
//!
//! What it can't: stop a lost key that turns up again. Nothing on a
//! peer-to-peer network can prove a key is gone, so a recovered account's
//! money doesn't move on this zome's word -- an issuer reissues it, once,
//! after a wait (see RECOVERY.md); and everyone's app refuses to deal with
//! a key whose account has moved on.

pub use account_types::*;
use hdi::prelude::*;
use ledger_types::{LedgerEntry, LedgerKind};
use relay_integrity_support::chain::{entries_created, wrote_since};
use relay_integrity_support::{classify, decode, first_problem, invalid, linked_record, require, sealed_chunks_problem, valid, Checked};

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    RecoveryPlan(RecoveryPlan),
    Vouch(Vouch),
    Succession(Succession),
    Parcel(Parcel),
    Migration(Migration),
    Arrival(Arrival),
}

#[hdk_link_types]
pub enum LinkTypes {
    /// An account's plans, base = the account -- its latest is current.
    AccountToPlan,
    /// A plan, base = its recovery phrase's key -- how the phrase finds the
    /// account it recovers.
    PhraseKeyToPlan,
    /// A plan, base = each guardian it names -- who they guard.
    GuardianToPlan,
    /// A guardian's vouch, base = the successor it's for.
    SuccessorToVouch,
    /// A succession, base = the account it took over -- whether, and to
    /// whom, an account has moved on.
    PredecessorToSuccession,
    /// A succession, base = its author -- the account a key carries on.
    SuccessorToSuccession,
    /// A hand-over's parcel, base = the successor it's sealed to.
    SuccessorToParcel,
    /// A recovered account asking an issuer to reissue its balance, base =
    /// the issuer.
    IssuerToReissue,
    /// An account moving to the next network, asking an issuer to carry its
    /// balance there, base = the issuer.
    IssuerToMigration,
    /// The same, base = the successor -- how the new network's key finds
    /// what was moved to it.
    SuccessorToMigration,
    /// An account's arrival from the previous network, base = its author.
    AccountToArrival,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match classify(op.flattened::<EntryTypes, LinkTypes>()?)? {
        Checked::Create { entry, action } => match entry {
            EntryTypes::RecoveryPlan(plan) => validate_plan(&plan, action.author()),
            EntryTypes::Vouch(vouch) => validate_vouch(&vouch, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::Succession(succession) => validate_succession(&succession, action.author(), action.prev_action()),
            EntryTypes::Parcel(parcel) => validate_parcel(&parcel, action.author()),
            EntryTypes::Migration(migration) => validate_migration(&migration, action.author(), action.prev_action()),
            EntryTypes::Arrival(arrival) => validate_arrival(&arrival, action.author(), action.prev_action()),
        },
        Checked::Update { .. } => invalid("account entries can't be changed: publish a new plan instead"),
        Checked::Delete { .. } => invalid("account entries can't be deleted"),
        Checked::CreateLink { link_type, action } => validate_create_link(link_type, &action.base_address, &action.target_address, action.author()),
        Checked::DeleteLink { .. } => invalid("account links can't be deleted"),
        Checked::Other => valid(),
    }
}

fn validate_plan(plan: &RecoveryPlan, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if plan.phrase_key.as_ref() == Some(author) {
        return invalid("a recovery phrase's key is its own, not the account's");
    }
    if plan.guardians.len() > MAX_GUARDIANS {
        return invalid("a plan names too many guardians");
    }
    if plan.guardians.iter().any(|g| g == author || Some(g) == plan.phrase_key.as_ref()) {
        return invalid("a guardian is someone else");
    }
    let mut distinct = plan.guardians.clone();
    distinct.sort_by(|a, b| a.get_raw_39().cmp(b.get_raw_39()));
    distinct.dedup();
    if distinct.len() != plan.guardians.len() {
        return invalid("a plan names each guardian once");
    }
    let threshold = usize::from(plan.threshold);
    if plan.guardians.is_empty() {
        require(threshold == 0, "a plan without guardians needs no vouches")
    } else {
        require((1..=plan.guardians.len()).contains(&threshold), "a plan needs between one and all of its guardians to vouch")
    }
}

fn validate_vouch(vouch: &Vouch, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(prev_action) = prev_action else { return invalid("a vouch can't open a chain") };
    let record = must_get_valid_record(vouch.plan.clone())?;
    let Some(plan) = decode::<RecoveryPlan>(&record) else { return invalid("a vouch cites the account's recovery plan") };
    if record.action().author() != &vouch.account {
        return invalid("a vouch cites the account's own plan");
    }
    if !plan.guardians.contains(author) {
        return invalid("only a guardian the plan names may vouch");
    }
    if &vouch.successor == author || vouch.successor == vouch.account {
        return invalid("a guardian vouches for someone else's new key");
    }
    let planned_at = record.action().timestamp();
    if at < planned_at {
        return invalid("a vouch comes after the plan it cites");
    }
    let again = wrote_since(author, prev_action, planned_at, entry_type(UnitEntryTypes::Vouch)?, |v: &Vouch| v.account == vouch.account && v.plan == vouch.plan)?;
    require(!again, "a guardian vouches once for each account and plan")
}

fn validate_succession(succession: &Succession, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(prev_action) = prev_action else { return invalid("a succession can't open a chain") };
    if &succession.predecessor == author {
        return invalid("a key takes over another account, not its own");
    }
    if !entries_created(author, ChainFilter::new(prev_action.clone()), &[entry_type(UnitEntryTypes::Succession)?])?.is_empty() {
        return invalid("a key takes over one account");
    }
    let predecessor = &succession.predecessor;
    match &succession.authority {
        Authority::HandOver { bequest } => {
            let record = must_get_valid_record(bequest.clone())?;
            let handed_to = match decode::<LedgerEntry>(&record).map(|e| e.kind) {
                Some(LedgerKind::HandOver { successor }) => successor,
                _ => return invalid("a hand-over cites the account's hand-over"),
            };
            require(record.action().author() == predecessor && &handed_to == author, "a hand-over passes the account to the key it names")
        }
        Authority::Phrase { plan, head, signature } => {
            let plan = match plan_as_of(predecessor, plan, head)? {
                Ok(plan) => plan,
                Err(reason) => return invalid(reason),
            };
            let Some(key) = plan.phrase_key else { return invalid("that plan has no recovery phrase") };
            let signed = verify_signature_raw(key, signature.clone(), phrase_message(predecessor, author, head))?;
            require(signed, "that isn't the recovery phrase's signature for this key")
        }
        Authority::Guardians { plan: plan_ref, head, vouches } => {
            let plan = match plan_as_of(predecessor, plan_ref, head)? {
                Ok(plan) => plan,
                Err(reason) => return invalid(reason),
            };
            if plan.threshold == 0 || vouches.len() > MAX_GUARDIANS {
                return invalid("that plan can't be recovered by guardians");
            }
            let mut guardians: Vec<AgentPubKey> = Vec::new();
            for vouch_ref in vouches {
                let record = must_get_valid_record(vouch_ref.clone())?;
                let Some(vouch) = decode::<Vouch>(&record) else { return invalid("guardians recover an account with their vouches") };
                if &vouch.account != predecessor || &vouch.successor != author || &vouch.plan != plan_ref {
                    return invalid("each vouch must be for this account, this key and this plan");
                }
                // Validated: the plan names its author.
                let guardian = record.action().author().clone();
                if guardians.contains(&guardian) {
                    return invalid("each guardian counts once");
                }
                guardians.push(guardian);
            }
            require(guardians.len() >= usize::from(plan.threshold), "not enough guardians have vouched")
        }
    }
}

/// `plan_ref`, if it's `predecessor`'s latest plan as of `head` (an action
/// on their chain) -- or why not. A plan they replaced no longer counts, so
/// a guardian they dropped, or a phrase they changed, can't recover them
/// from where they stand now.
///
/// Walks only from `head` back to the plan, never the whole chain: the cost
/// is the account's activity since its plan, which its app keeps short by
/// re-affirming the plan from time to time (account coordinator,
/// `reaffirm_recovery_plan`).
fn plan_as_of(predecessor: &AgentPubKey, plan_ref: &ActionHash, head: &ActionHash) -> ExternResult<Result<RecoveryPlan, &'static str>> {
    let head_action = must_get_action(head.clone())?;
    if &head_action.hashed.content.header.author != predecessor {
        return Ok(Err("where the account stood must be on its own chain"));
    }
    let plan_action = must_get_action(plan_ref.clone())?;
    // On the same chain, at or before where the account stood -- so the
    // walk between them ends at the plan.
    if &plan_action.hashed.content.header.author != predecessor || plan_action.hashed.content.header.action_seq > head_action.hashed.content.header.action_seq {
        return Ok(Err("that account has no such recovery plan"));
    }
    let plan_type = EntryType::try_from(UnitEntryTypes::RecoveryPlan)?;
    for item in must_get_agent_activity(predecessor.clone(), ChainFilter::until_hash(head.clone(), plan_ref.clone()))? {
        if &item.action.hashed.hash == plan_ref {
            continue;
        }
        if let ActionData::Create(create) = &item.action.hashed.content.data {
            if create.entry_type == plan_type {
                return Ok(Err("that isn't the account's latest recovery plan"));
            }
        }
    }
    let record = must_get_valid_record(plan_ref.clone())?;
    Ok(decode::<RecoveryPlan>(&record).ok_or("that isn't a recovery plan"))
}

fn validate_parcel(parcel: &Parcel, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if &parcel.successor == author {
        return invalid("a parcel is for the account's new key");
    }
    match first_problem([sealed_chunks_problem("a parcel", &parcel.sealed, MAX_PARCEL_BYTES)]) {
        Some(problem) => Ok(problem),
        None => valid(),
    }
}

/// An account moves on to another network: this one can't be its own next
/// version. Its first migration is the one that counts, which readers take
/// (account coordinator, `first_migration_of`): checking here that it's the
/// only one would mean walking the account's whole chain, however long.
fn validate_migration(migration: &Migration, _author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    if prev_action.is_none() {
        return invalid("a migration can't open a chain");
    }
    require(migration.network != dna_info()?.hash, "an account migrates to another network")
}

/// An account arrives once, from another network.
fn validate_arrival(arrival: &Arrival, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(prev_action) = prev_action else { return invalid("an arrival can't open a chain") };
    if arrival.previous_network == dna_info()?.hash {
        return invalid("an account arrives from another network");
    }
    require(
        entries_created(author, ChainFilter::new(prev_action.clone()), &[entry_type(UnitEntryTypes::Arrival)?])?.is_empty(),
        "an account arrives once",
    )
}

fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let Some(record) = linked_record(target)? else {
        return invalid("account links must target a record");
    };
    if author != record.action().author() {
        return invalid("an account link is made by the author of the entry it indexes");
    }
    let bases: Vec<AnyLinkableHash> = match link_type {
        LinkTypes::AccountToPlan => decode::<RecoveryPlan>(&record).map(|_| vec![author.clone().into()]).unwrap_or_default(),
        LinkTypes::PhraseKeyToPlan => decode::<RecoveryPlan>(&record).and_then(|p| p.phrase_key).map(|k| vec![k.into()]).unwrap_or_default(),
        LinkTypes::GuardianToPlan => decode::<RecoveryPlan>(&record).map(|p| p.guardians.into_iter().map(Into::into).collect()).unwrap_or_default(),
        LinkTypes::SuccessorToVouch => decode::<Vouch>(&record).map(|v| vec![v.successor.into()]).unwrap_or_default(),
        LinkTypes::PredecessorToSuccession => decode::<Succession>(&record).map(|s| vec![s.predecessor.into()]).unwrap_or_default(),
        LinkTypes::SuccessorToSuccession => decode::<Succession>(&record).map(|_| vec![author.clone().into()]).unwrap_or_default(),
        LinkTypes::SuccessorToParcel => decode::<Parcel>(&record).map(|p| vec![p.successor.into()]).unwrap_or_default(),
        LinkTypes::SuccessorToMigration => decode::<Migration>(&record).map(|m| vec![m.successor.into()]).unwrap_or_default(),
        LinkTypes::AccountToArrival => decode::<Arrival>(&record).map(|_| vec![author.clone().into()]).unwrap_or_default(),
        LinkTypes::IssuerToMigration => {
            let issuer = base.clone().into_agent_pub_key();
            if decode::<Migration>(&record).is_none() || !issuer.map(|i| relay_governance::is_issuer(&i)).transpose()?.unwrap_or(false) {
                return invalid("a migration asks an issuer on the roster to carry its balance");
            }
            vec![base.clone()]
        }
        LinkTypes::IssuerToReissue => {
            // Only a recovery is reissued (a hand-over moves its own money),
            // and only by an issuer on the roster.
            let recovered = decode::<Succession>(&record).is_some_and(|s| s.authority.is_recovery());
            let issuer = base.clone().into_agent_pub_key();
            if !recovered || !issuer.map(|i| relay_governance::is_issuer(&i)).transpose()?.unwrap_or(false) {
                return invalid("a recovered account asks an issuer on the roster to reissue it");
            }
            vec![base.clone()]
        }
    };
    if bases.is_empty() {
        return invalid("an account link's target is not the entry its link type indexes");
    }
    require(bases.contains(base), "an account link must sit under the key its entry is about")
}

fn entry_type(unit: UnitEntryTypes) -> ExternResult<ScopedEntryDefIndex> {
    ScopedEntryDefIndex::try_from(unit)
}
