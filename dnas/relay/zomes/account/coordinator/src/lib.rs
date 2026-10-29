//! Coordinator zome for accounts: a person's recovery plan, guardians
//! vouching, a new key recovering an account whose key was lost, moving to
//! the next network, and the check a phone makes before it sends its key to
//! a new one. See `account_integrity` for what validation guarantees, and
//! RECOVERY.md for the whole design.

use account_integrity::*;
use hdk::prelude::*;

mod device;
mod migration;
mod plans;
mod reissue;
mod succession;
pub use device::*;
pub use migration::*;
pub use plans::*;
pub use reissue::*;
pub use succession::*;

pub(crate) use relay_coordinator_support::guest;

pub(crate) fn me() -> ExternResult<AgentPubKey> {
    Ok(agent_info()?.agent_initial_pubkey)
}

/// The records `query`'s links point at, oldest first -- each read the
/// way the links were: on this device (`GetStrategy::Local`) or from the
/// network.
pub(crate) fn linked_records(query: LinkQuery, strategy: GetStrategy) -> ExternResult<Vec<Record>> {
    let mut links = get_links(query, strategy)?;
    links.sort_by_key(|l| l.timestamp);
    let options = if strategy == GetStrategy::Local { GetOptions::local() } else { GetOptions::default() };
    let mut records = Vec::with_capacity(links.len());
    for link in links {
        let Some(hash) = link.target.into_action_hash() else { continue };
        if let Some(record) = get(hash, options.clone())? {
            records.push(record);
        }
    }
    Ok(records)
}

/// `account`'s links of `link_type` from their own key, by them -- an
/// account's own index, which only it writes.
pub(crate) fn own_links(account: &AgentPubKey, link_type: LinkTypes) -> ExternResult<LinkQuery> {
    Ok(LinkQuery::try_new(account.clone(), link_type)?.author(account.clone()))
}

/// The caller's own records their key links to with `link_type`, oldest
/// first -- read on this device, from the index, not the whole chain.
pub(crate) fn my_linked(link_type: LinkTypes) -> ExternResult<Vec<Record>> {
    linked_records(own_links(&me()?, link_type)?, GetStrategy::Local)
}

pub(crate) fn decoded<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(record: &Record) -> Option<T> {
    relay_coordinator_support::decode_or::<T>(record)
}

#[cfg(feature = "test-utils")]
mod test_utils {
    use account_integrity::{EntryTypes, LinkTypes, Parcel, RecoveryPlan, Succession, Vouch};
    use hdk::prelude::*;
    relay_coordinator_support::raw_link_test_externs!(AccountToPlan, PhraseKeyToPlan, GuardianToPlan, SuccessorToVouch, PredecessorToSuccession, SuccessorToSuccession, SuccessorToParcel, IssuerToReissue, IssuerToMigration, SuccessorToMigration, AccountToArrival);

    /// Writes each entry exactly as given, skipping the coordinator's checks
    /// -- what a modified client could.
    #[hdk_extern]
    pub fn create_raw_plan_for_testing(plan: RecoveryPlan) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::RecoveryPlan(plan))
    }

    #[hdk_extern]
    pub fn create_raw_vouch_for_testing(vouch: Vouch) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::Vouch(vouch))
    }

    #[hdk_extern]
    pub fn create_raw_succession_for_testing(succession: Succession) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::Succession(succession))
    }

    #[hdk_extern]
    pub fn create_raw_parcel_for_testing(parcel: Parcel) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::Parcel(parcel))
    }

    #[hdk_extern]
    pub fn create_raw_migration_for_testing(migration: account_integrity::Migration) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::Migration(migration))
    }

    #[hdk_extern]
    pub fn create_raw_arrival_for_testing(arrival: account_integrity::Arrival) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::Arrival(arrival))
    }
}
