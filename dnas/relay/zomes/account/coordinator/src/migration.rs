//! Moving an account to the next version of the network -- a different DNA
//! (MIGRATION.md). The account seals what's private to its key on the new
//! network, records where it's going, and closes its chain: Holochain
//! accepts nothing more from it here, so what its ledger held is final. An
//! issuer on both networks credits that, once, to the key on the new one.

use crate::{decoded, guest, linked_records, me};
use account_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{next_page_cursor, seal_chunked};

#[derive(Serialize, Deserialize, Debug)]
pub struct MigrateInput {
    /// The next network's DNA.
    pub network: DnaHash,
    /// The account's key there.
    pub successor: AgentPubKey,
    /// The issuer that carries its balance over.
    pub issuer: AgentPubKey,
    /// What only this key can read, for the new one (the app's own encoding)
    /// -- empty for nothing.
    pub parcel: String,
}

/// Something that would be stranded by closing the chain now, or `None`.
fn unfinished() -> ExternResult<Option<String>> {
    // Any entry at all: what they are doesn't matter here.
    let busy = |zome: &str, function: &str| -> ExternResult<bool> {
        Ok(match call(CallTargetCell::Local, zome, function.into(), None, ())? {
            ZomeCallResponse::Ok(io) => !io.decode::<Vec<serde::de::IgnoredAny>>().map_err(|e| wasm_error!(e))?.is_empty(),
            _ => false,
        })
    };
    if busy("dispatch", "get_my_active_orders")? || busy("dispatch", "get_my_active_deliveries")? {
        return Ok(Some("Finish your orders in progress first: what they owe you can only come to this account.".into()));
    }
    #[derive(Deserialize, Debug)]
    struct CatalogView {
        original_action: ActionHash,
    }
    if let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "catalog", "list_my_catalogs".into(), None, ())? {
        for store in io.decode::<Vec<CatalogView>>().map_err(|e| wasm_error!(e))? {
            if let ZomeCallResponse::Ok(listed) = call(CallTargetCell::Local, "catalog", "is_store_listed".into(), None, store.original_action)? {
                if listed.decode::<bool>().map_err(|e| wasm_error!(e))? {
                    return Ok(Some("Take your stores' listings down first: their stakes come back only to this account.".into()));
                }
            }
        }
    }
    Ok(None)
}

/// Moves the caller's account to the next network: seals `parcel` to its
/// key there, records the move (asking `issuer` to carry the balance), and
/// closes the chain. After this, this key does nothing more on this network.
#[hdk_extern]
pub fn migrate_out(input: MigrateInput) -> ExternResult<ActionHash> {
    if input.network == dna_info()?.hash {
        return Err(guest("That's this network: the account moves to the next one."));
    }
    if !relay_governance::is_issuer(&input.issuer)? {
        return Err(guest("That isn't one of this network's issuers."));
    }
    if let Some(reason) = unfinished()? {
        return Err(guest(reason));
    }
    if input.parcel.len() > MAX_PARCEL_BYTES {
        return Err(guest("There's too much to carry over at once."));
    }
    if !input.parcel.is_empty() {
        let sealed = seal_chunked(&input.successor, &input.parcel)?;
        let hash = create_entry(&EntryTypes::Parcel(Parcel { successor: input.successor.clone(), sealed }))?;
        create_link(input.successor.clone(), hash, LinkTypes::SuccessorToParcel, ())?;
    }
    let hash = create_entry(&EntryTypes::Migration(Migration { network: input.network.clone(), successor: input.successor.clone() }))?;
    create_link(input.issuer, hash.clone(), LinkTypes::IssuerToMigration, ())?;
    create_link(input.successor, hash.clone(), LinkTypes::SuccessorToMigration, ())?;
    close_chain(Some(MigrationTarget::Dna(input.network)))?;
    Ok(hash)
}

/// Where an account's chain was closed, if it was: the network it moved to,
/// and the closing action.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Closed {
    pub network: Option<DnaHash>,
    pub close: ActionHash,
}

/// Whether `agent` has closed their chain here (moved to another network).
#[hdk_extern]
pub fn chain_closed(agent: AgentPubKey) -> ExternResult<Option<Closed>> {
    let Some((_, last)) = relay_coordinator_support::agent_activity(agent, ChainQueryFilter::new())?.pop() else { return Ok(None) };
    let Some(record) = get(last.clone(), GetOptions::default())? else { return Ok(None) };
    Ok(match &record.action().data {
        ActionData::CloseChain(close) => Some(Closed {
            network: match &close.new_target {
                Some(MigrationTarget::Dna(dna)) => Some(dna.clone()),
                _ => None,
            },
            close: last,
        }),
        _ => None,
    })
}

/// An account moving to the next network, as its issuer sees it.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MigrationRequest {
    pub migration: ActionHash,
    pub account: AgentPubKey,
    pub successor: AgentPubKey,
    pub network: DnaHash,
    pub requested_at: Timestamp,
    /// The closed chain's last action -- `None` until the close is seen.
    pub close: Option<ActionHash>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MigrationRequestsInput {
    pub after: Option<Timestamp>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MigrationRequestsPage {
    pub requests: Vec<MigrationRequest>,
    /// As `CashOutRequestsPage::cursor`.
    pub cursor: Option<Timestamp>,
    pub more: bool,
}

const REQUESTS_PAGE_SIZE: usize = 50;

/// `account`'s first migration -- the only one that counts. An account
/// moves once: its chain closes behind the move, and a modified app that
/// wrote a second before closing gets nothing for it (validation leaves
/// this to readers, so it never walks a long chain to check).
pub(crate) fn first_migration_of(account: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
    let filter = ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::Migration)?);
    Ok(relay_coordinator_support::agent_activity(account.clone(), filter)?.into_iter().min_by_key(|(seq, _)| *seq).map(|(_, hash)| hash))
}

/// The accounts moving to the next network that asked the caller, an
/// issuer, to carry their balance, oldest first, a page at a time.
#[hdk_extern]
pub fn get_migration_requests(input: MigrationRequestsInput) -> ExternResult<MigrationRequestsPage> {
    let mut query = LinkQuery::try_new(me()?, LinkTypes::IssuerToMigration)?;
    query.after = input.after;
    let mut links = get_links(query, GetStrategy::default())?;
    links.sort_by_key(|l| l.timestamp);
    let more = links.len() > REQUESTS_PAGE_SIZE;
    links.truncate(REQUESTS_PAGE_SIZE);
    let cursor = links.last().map(|l| next_page_cursor(l.timestamp)).or(input.after);
    let mut requests = Vec::with_capacity(links.len());
    for link in links {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash.clone(), GetOptions::default())? else { continue };
        let Some(migration) = decoded::<Migration>(&record) else { continue };
        let account = record.action().author().clone();
        if first_migration_of(&account)?.as_ref() != Some(&hash) {
            continue;
        }
        let close = chain_closed(account.clone())?.filter(|c| c.network.as_ref() == Some(&migration.network)).map(|c| c.close);
        requests.push(MigrationRequest { migration: hash, account, successor: migration.successor, network: migration.network, requested_at: link.timestamp, close });
    }
    Ok(MigrationRequestsPage { requests, cursor, more })
}

/// The accounts moved to the caller's key from this network -- what the
/// next network's app reads here (it carries this network as its
/// `previous` role).
#[hdk_extern]
pub fn migrations_to_me(_: ()) -> ExternResult<Vec<MigrationRequest>> {
    let me = me()?;
    let mut found = Vec::new();
    for record in linked_records(me.clone(), LinkTypes::SuccessorToMigration)? {
        let Some(migration) = decoded::<Migration>(&record) else { continue };
        if migration.successor != me {
            continue;
        }
        let account = record.action().author().clone();
        if first_migration_of(&account)?.as_ref() != Some(record.action_address()) {
            continue;
        }
        let close = chain_closed(account.clone())?.map(|c| c.close);
        found.push(MigrationRequest { migration: record.action_address().clone(), account, successor: migration.successor, network: migration.network, requested_at: record.action().timestamp(), close });
    }
    Ok(found)
}

// --- arriving on the next network ---

/// The app role that carries the previous network, when there is one.
pub const PREVIOUS_ROLE: &str = "previous";

/// Calls `function` in `zome` on the previous network (the app's `previous`
/// role) -- `None` if this app has no previous network, or it won't answer.
pub(crate) fn on_previous<I: Serialize + std::fmt::Debug, O: for<'de> Deserialize<'de> + std::fmt::Debug>(zome: &str, function: &str, input: I) -> ExternResult<Option<O>> {
    match call(CallTargetCell::OtherRole(PREVIOUS_ROLE.into()), zome, function.into(), None, input) {
        Ok(ZomeCallResponse::Ok(io)) => Ok(io.decode().ok()),
        _ => Ok(None),
    }
}

/// This network's DNA -- what an app asks of its previous role.
#[hdk_extern]
pub fn network_hash(_: ()) -> ExternResult<DnaHash> {
    Ok(dna_info()?.hash)
}

/// A migration record on this network, by its action -- what the next
/// network checks an arrival against.
#[hdk_extern]
pub fn get_migration(migration: ActionHash) -> ExternResult<Option<MigrationRequest>> {
    let Some(record) = get(migration.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(m) = decoded::<Migration>(&record) else { return Ok(None) };
    let account = record.action().author().clone();
    if first_migration_of(&account)?.as_ref() != Some(&migration) {
        return Ok(None);
    }
    let close = chain_closed(account.clone())?.map(|c| c.close);
    Ok(Some(MigrationRequest { migration, account, successor: m.successor, network: m.network, requested_at: record.action().timestamp(), close }))
}

/// Records the caller's arrival from the previous network: the account
/// there whose migration -- now closed -- names them. Safe to repeat;
/// returns the account they arrived as.
#[hdk_extern]
pub fn arrive(_: ()) -> ExternResult<AgentPubKey> {
    if let Some(arrival) = my_arrival()? {
        return Ok(arrival.previous_account);
    }
    let here = dna_info()?.hash;
    let previous_network: DnaHash = on_previous("account", "network_hash", ())?.ok_or(guest("This app has no previous version to arrive from."))?;
    let moved: Vec<MigrationRequest> = on_previous("account", "migrations_to_me", ())?.unwrap_or_default();
    let migration = moved
        .into_iter()
        .find(|m| m.network == here && m.close.is_some())
        .ok_or(guest("Nothing has been moved to this device yet: move your account from the previous version first."))?;
    let arrival = Arrival { previous_network, previous_account: migration.account.clone(), migration: migration.migration };
    let hash = create_entry(&EntryTypes::Arrival(arrival))?;
    create_link(me()?, hash, LinkTypes::AccountToArrival, ())?;
    Ok(migration.account)
}

fn my_arrival() -> ExternResult<Option<Arrival>> {
    let mine = query(ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::Arrival)?).include_entries(true))?;
    Ok(mine.first().and_then(decoded::<Arrival>))
}

/// The account `agent` was on the previous network, if they arrived from
/// it -- checked there: its migration, to this network and this key, and
/// its chain closed. `None` without a previous network to check against.
#[hdk_extern]
pub fn arrived_from(agent: AgentPubKey) -> ExternResult<Option<AgentPubKey>> {
    let Some(arrival) = linked_records(agent.clone(), LinkTypes::AccountToArrival)?.iter().filter(|r| r.action().author() == &agent).find_map(decoded::<Arrival>) else {
        return Ok(None);
    };
    let Some(previous_network) = on_previous::<_, DnaHash>("account", "network_hash", ())? else { return Ok(None) };
    if previous_network != arrival.previous_network {
        return Ok(None);
    }
    let Some(migration) = on_previous::<_, Option<MigrationRequest>>("account", "get_migration", arrival.migration)?.flatten() else { return Ok(None) };
    let genuine = migration.account == arrival.previous_account && migration.successor == agent && migration.network == dna_info()?.hash && migration.close.is_some();
    Ok(genuine.then_some(arrival.previous_account))
}
