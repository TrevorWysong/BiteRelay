//! Coordinator zome for rewards: a store's program, and its members' points
//! -- earned on their orders, spent on rewards at checkout, granted by the
//! store. Every write here goes on the caller's own chain, with the state
//! the shared rules (`rewards_types::points`) give it; validation checks the
//! same rules. See docs/REWARDS.md.

use handshake_coordinator_support::chain::{my_current_version, my_versions, mine};
use handshake_coordinator_support::{decode_or, guest, original_action_of, resolve_version, update_version};
use hdk::prelude::*;
use rewards_integrity::*;

fn points_entries() -> ExternResult<[EntryType; 1]> {
    Ok([EntryType::try_from(UnitEntryTypes::PointsEntry)?])
}

fn me() -> ExternResult<AgentPubKey> {
    Ok(agent_info()?.agent_initial_pubkey)
}

fn dispatch<I: Serialize + std::fmt::Debug, O: serde::de::DeserializeOwned + std::fmt::Debug>(function: &str, input: I) -> ExternResult<O> {
    match call(CallTargetCell::Local, "dispatch", function.into(), None, input)? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e)),
        other => Err(guest(format!("{function}: {other:?}"))),
    }
}

/// The store `catalog_ref` is, and its owner.
fn store(catalog_ref: &ActionHash) -> ExternResult<catalog_types::MerchantCatalog> {
    let record = get(catalog_ref.clone(), GetOptions::default())?.ok_or(guest("That store couldn't be found."))?;
    decode_or(&record).ok_or(guest("That isn't a store."))
}

// --- programs ---

/// A store's program at its current version.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProgramView {
    /// The program's identity (its original action).
    pub original: ActionHash,
    /// Its current version -- what an order placed now cites.
    pub version: ActionHash,
    pub program: RewardsProgram,
}

fn program_links(catalog_ref: &ActionHash) -> ExternResult<Vec<Link>> {
    get_links(LinkQuery::try_new(catalog_ref.clone(), LinkTypes::CatalogToProgram)?, GetStrategy::default())
}

/// `catalog_ref`'s program, current -- `None` if it has none. Only one its
/// owner wrote counts (validation allows no other).
#[hdk_extern]
pub fn program_of(catalog_ref: ActionHash) -> ExternResult<Option<ProgramView>> {
    let owner = store(&catalog_ref)?.owner;
    for link in program_links(&catalog_ref)? {
        let Some(original) = link.target.into_action_hash() else { continue };
        let Ok(current) = resolve_version(original.clone()) else { continue };
        if current.record.action().author() != &owner {
            continue;
        }
        if let Some(program) = decode_or::<RewardsProgram>(&current.record).filter(|p| p.catalog_ref == catalog_ref) {
            return Ok(Some(ProgramView { original, version: current.record.action_address().clone(), program }));
        }
    }
    Ok(None)
}

/// The caller's own program for their store, read from their chain.
fn my_program(catalog_ref: &ActionHash) -> ExternResult<Option<handshake_coordinator_support::EntryVersion>> {
    let types = [EntryType::try_from(UnitEntryTypes::RewardsProgram)?];
    let Some(original) = mine(&types).creates().find(|r| decode_or::<RewardsProgram>(r).is_some_and(|p| &p.catalog_ref == catalog_ref))? else { return Ok(None) };
    my_current_version(original.action_address().clone())
}

/// Sets up or changes the caller's store's program. Returns its current
/// version.
#[hdk_extern]
pub fn save_program(program: RewardsProgram) -> ExternResult<ActionHash> {
    if store(&program.catalog_ref)?.owner != me()? {
        return Err(guest("Only the store's owner can run its rewards program."));
    }
    if let Some(problem) = program.problem() {
        return Err(guest(problem));
    }
    let catalog_ref = program.catalog_ref.clone();
    match my_program(&catalog_ref)? {
        Some(current) => update_version(&current, &EntryTypes::RewardsProgram(program), LinkTypes::Version),
        None => {
            let hash = create_entry(&EntryTypes::RewardsProgram(program))?;
            create_link(catalog_ref, hash.clone(), LinkTypes::CatalogToProgram, ())?;
            Ok(hash)
        }
    }
}

/// One version of a program, as its store's chain holds it.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProgramVersion {
    pub action: ActionHash,
    pub written_at: Timestamp,
}

/// The caller's store's program, every version oldest first, from their own
/// chain -- what the store checks an order's cited version against before
/// accepting it (dispatch's `ensure_current_program`).
#[hdk_extern]
pub fn get_my_program_versions(catalog_ref: ActionHash) -> ExternResult<Vec<ProgramVersion>> {
    let types = [EntryType::try_from(UnitEntryTypes::RewardsProgram)?];
    let Some(original) = mine(&types).creates().find(|r| decode_or::<RewardsProgram>(r).is_some_and(|p| p.catalog_ref == catalog_ref))? else { return Ok(Vec::new()) };
    Ok(my_versions(original.action_address().clone())?.into_iter().map(|r| ProgramVersion { action: r.action_address().clone(), written_at: r.action().timestamp() }).collect())
}

// --- the member's card ---

/// The caller's latest entry at a store, and its hash.
fn my_latest(catalog_ref: &ActionHash) -> ExternResult<Option<(ActionHash, PointsEntry)>> {
    Ok(mine(&points_entries()?).find(|r| decode_or::<PointsEntry>(r).is_some_and(|e| &e.catalog_ref == catalog_ref))?.and_then(|r| decode_or::<PointsEntry>(&r).map(|e| (r.action_address().clone(), e))))
}

/// Writes the caller's next entry at a store, after their latest, with the
/// state the rules give it.
fn append(catalog_ref: &ActionHash, kind: PointsKind, program: &RewardsProgram, event: Event) -> ExternResult<(ActionHash, PointsEntry)> {
    let latest = my_latest(catalog_ref)?;
    let (state, points) = step(program, latest.as_ref().map(|(_, e)| &e.state), event).map_err(guest)?;
    let entry = PointsEntry { catalog_ref: catalog_ref.clone(), kind, points, state, previous: latest.map(|(hash, _)| hash) };
    let hash = create_entry(&EntryTypes::PointsEntry(entry.clone()))?;
    Ok((hash, entry))
}

/// One line of a member's history at a store.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PointsLine {
    pub entry: ActionHash,
    pub at: Timestamp,
    pub kind: PointsKind,
    /// Points in (positive) or out (negative).
    pub points: i64,
    /// What a grant said, if it said anything.
    pub note: Option<String>,
}

/// A member's card at a store: where they stand now, and lately.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CardView {
    pub catalog_ref: ActionHash,
    pub store_name: String,
    pub program: Option<ProgramView>,
    /// As of their latest entry.
    pub state: Option<PointsState>,
    /// What they can spend now -- after any expiry since.
    pub balance: u64,
    /// Their tier now (0 the base).
    pub tier: u8,
    /// When their points expire, if they do.
    pub expires_at: Option<Timestamp>,
    /// Newest first, at most `HISTORY`.
    pub history: Vec<PointsLine>,
}

const HISTORY: usize = 30;

/// A member's entries at a store, newest first: each one's hash and time.
type Entries = Vec<(ActionHash, Timestamp, PointsEntry)>;

fn card_of(catalog_ref: ActionHash, entries: Entries) -> ExternResult<CardView> {
    let program = program_of(catalog_ref.clone())?;
    let store_name = store(&catalog_ref).map(|s| s.business_name).unwrap_or_default();
    let state = entries.first().map(|(_, _, e)| e.state.clone());
    let now = sys_time()?;
    let (balance, tier, expires_at) = match (&program, &state) {
        (Some(view), Some(state)) => {
            let rolled = roll(&view.program, state, now);
            (rolled.balance, tier_of(&view.program, &rolled), expires_at(&view.program, state).filter(|_| rolled.balance > 0))
        }
        (_, Some(state)) => (state.balance, 0, None),
        _ => (0, 0, None),
    };
    let mut history = Vec::new();
    for (entry, at, e) in entries.into_iter().take(HISTORY) {
        let points = i64::try_from(e.points).unwrap_or(i64::MAX);
        let note = match &e.kind {
            PointsKind::Gift { grant } => get(grant.clone(), GetOptions::default())?.and_then(|r| decode_or::<PointsGrant>(&r)).and_then(|g| match g.reason {
                GrantReason::Goodwill { note } if !note.is_empty() => Some(note),
                _ => None,
            }),
            _ => None,
        };
        history.push(PointsLine { entry, at, points: if matches!(e.kind, PointsKind::Redeem { .. }) { -points } else { points }, kind: e.kind, note });
    }
    Ok(CardView { catalog_ref, store_name, program, state, balance, tier, expires_at, history })
}

fn my_entries() -> ExternResult<Entries> {
    Ok(mine(&points_entries()?).records()?.into_iter().filter_map(|r| decode_or::<PointsEntry>(&r).map(|e| (r.action_address().clone(), r.action().timestamp(), e))).collect())
}

/// The caller's card at a store -- with the store's program even before
/// they've earned anything there.
#[hdk_extern]
pub fn my_card(catalog_ref: ActionHash) -> ExternResult<CardView> {
    let entries = my_entries()?.into_iter().filter(|(_, _, e)| e.catalog_ref == catalog_ref).collect();
    card_of(catalog_ref, entries)
}

/// Every card the caller holds, most recently used first.
#[hdk_extern]
pub fn my_cards(_: ()) -> ExternResult<Vec<CardView>> {
    let mut stores: Vec<(ActionHash, Entries)> = Vec::new();
    for item in my_entries()? {
        match stores.iter_mut().find(|(store, _)| store == &item.2.catalog_ref) {
            Some((_, entries)) => entries.push(item),
            None => stores.push((item.2.catalog_ref.clone(), vec![item])),
        }
    }
    stores.into_iter().map(|(store, entries)| card_of(store, entries)).collect()
}

// --- earning ---

/// Earns what one of the caller's orders (any version) earns, once the
/// store has settled it. `None` if there's nothing to earn yet -- or ever:
/// it didn't join a program, earns nothing, or already earned. Safe to
/// repeat; dispatch's sweep calls it for every recent order.
#[hdk_extern]
pub fn earn_for_order(order: ActionHash) -> ExternResult<Option<ActionHash>> {
    let order = original_action_of(order)?;
    let Some(record) = get(order.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(placed) = OrderForRewards::of(&record) else { return Ok(None) };
    if placed.requester != me()? || placed.rewards.is_none() {
        return Ok(None);
    }
    let since = record.action().timestamp();
    let earned = mine(&points_entries()?).since(since).any(|r| decode_or::<PointsEntry>(r).is_some_and(|e| matches!(&e.kind, PointsKind::Earn { order: o, .. } if o == &order)))?;
    if earned {
        return Ok(None);
    }
    let Some(settlement) = dispatch::<_, Option<ActionHash>>("order_settlement", order.clone())? else { return Ok(None) };
    let earning = match earning(&order, &settlement)? {
        Ok(earning) => earning,
        Err(_) => return Ok(None),
    };
    let catalog_ref = earning.order.catalog_ref.clone();
    let event = Event::Earn { at: earning.settled_at, base: earning.base };
    // An order that earns nothing (below the minimum, all refunded) is
    // simply skipped.
    if step(&earning.program, my_latest(&catalog_ref)?.as_ref().map(|(_, e)| &e.state), event).is_err() {
        return Ok(None);
    }
    let (hash, entry) = append(&catalog_ref, PointsKind::Earn { order, settlement }, &earning.program, event)?;
    create_link(catalog_ref.clone(), hash.clone(), LinkTypes::CatalogToMember, LinkTag::new(entry.points.to_be_bytes().to_vec()))?;
    link_birthday(&catalog_ref)?;
    Ok(Some(hash))
}

// --- redeeming ---

#[derive(Serialize, Deserialize, Debug)]
pub struct RedeemInput {
    pub catalog_ref: ActionHash,
    /// The program version the order will cite.
    pub program: ActionHash,
    pub reward: u16,
}

/// Spends the caller's points on a reward, for the order dispatch writes
/// in this same call -- the order cites it, and validation lets it pay for
/// no other. Not for calling on its own: points spent without an order are
/// gone.
#[hdk_extern]
pub fn redeem(input: RedeemInput) -> ExternResult<ActionHash> {
    let Ok(program) = program_at(&input.program, &input.catalog_ref)? else { return Err(guest("That rewards program couldn't be found.")) };
    if !program.active {
        return Err(guest("This store's rewards program is paused."));
    }
    let reward = program.reward(input.reward).ok_or(guest("That reward isn't offered anymore."))?;
    let event = Event::Spend { at: sys_time()?, cost: u64::from(reward.cost), min_tier: reward.min_tier };
    // Told plainly first; `append` writes it.
    step(&program, my_latest(&input.catalog_ref)?.as_ref().map(|(_, e)| &e.state), event).map_err(|reason| {
        if reason == "that reward needs a higher tier" {
            guest("That reward is for a higher tier.")
        } else {
            guest("You don't have enough points for that reward.")
        }
    })?;
    let (hash, _) = append(&input.catalog_ref, PointsKind::Redeem { program: input.program, reward: input.reward }, &program, event)?;
    create_link(input.catalog_ref, hash.clone(), LinkTypes::CatalogToRedemption, ())?;
    Ok(hash)
}

/// The caller's redemptions that no order used, back -- each once its
/// window has passed (`PointsKind::Unspend`): an order that failed after
/// its points were spent, or a checkout abandoned midway. Looks back 30
/// days. Returns how many came back.
#[hdk_extern]
pub fn reclaim_unspent(_: ()) -> ExternResult<u32> {
    let now = sys_time()?;
    let window = REDEMPTION_WINDOW_SECS * 1_000_000;
    let since = Timestamp::from_micros(now.as_micros() - 30 * 86_400_000_000);
    let entries = mine(&points_entries()?).since(since).records()?;
    let back: Vec<ActionHash> = entries.iter().filter_map(|r| match decode_or::<PointsEntry>(r)?.kind {
        PointsKind::Unspend { redemption } => Some(redemption),
        _ => None,
    }).collect();
    let mut count = 0;
    for record in &entries {
        let Some(PointsEntry { kind: PointsKind::Redeem { .. }, .. }) = decode_or::<PointsEntry>(record) else { continue };
        let redeemed_at = record.action().timestamp();
        if now.as_micros() - redeemed_at.as_micros() <= window + 60_000_000 || back.contains(record.action_address()) {
            continue;
        }
        if handshake_coordinator_support::isolated::<_, Option<ActionHash>>("reclaim_one", record.action_address().clone()).flatten().is_some() {
            count += 1;
        }
    }
    Ok(count)
}

/// One redemption back, if no order of the caller's cites it
/// (`reclaim_unspent`).
#[hdk_extern]
pub fn reclaim_one(redemption: ActionHash) -> ExternResult<Option<ActionHash>> {
    let record = get(redemption.clone(), GetOptions::local())?.ok_or(guest("redemption not found"))?;
    let Some(spent) = decode_or::<PointsEntry>(&record) else { return Ok(None) };
    let PointsKind::Redeem { program: program_ref, .. } = &spent.kind else { return Ok(None) };
    let me = me()?;
    let head = agent_info()?.chain_head.0;
    let types: Vec<ScopedEntryDefIndex> = [dispatch_order_type("DeliveryOrder")?, dispatch_order_type("PickupOrder")?].into_iter().flatten().collect();
    let cited = handshake_integrity_support::chain::entries_since(&me, &head, record.action().timestamp(), &types)?.into_iter().any(|bytes| {
        let rewards = dispatch_types::DeliveryOrder::try_from(bytes.clone()).ok().and_then(|o| o.rewards).or_else(|| dispatch_types::PickupOrder::try_from(bytes).ok().and_then(|o| o.rewards));
        rewards.and_then(|r| r.redemption).as_ref() == Some(&redemption)
    });
    if cited {
        return Ok(None);
    }
    let Ok(program) = program_at(program_ref, &spent.catalog_ref)? else { return Ok(None) };
    let (hash, _) = append(&spent.catalog_ref, PointsKind::Unspend { redemption }, &program, Event::Credit { at: sys_time()?, points: spent.points })?;
    Ok(Some(hash))
}

// --- grants ---

/// Writes a grant from the caller's store, and links it to its member.
fn grant(to: AgentPubKey, catalog_ref: ActionHash, points: u32, reason: GrantReason) -> ExternResult<ActionHash> {
    let program = my_program(&catalog_ref)?.ok_or(guest("Set up your rewards program first."))?;
    let hash = create_entry(&EntryTypes::PointsGrant(PointsGrant { to: to.clone(), catalog_ref, program: program.record.action_address().clone(), points, reason }))?;
    create_link(to, hash.clone(), LinkTypes::AgentToGrant, ())?;
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GrantInput {
    pub to: AgentPubKey,
    pub catalog_ref: ActionHash,
    pub points: u32,
    pub note: String,
}

/// The caller's store giving a member points -- an apology, a thank-you.
#[hdk_extern]
pub fn grant_points(input: GrantInput) -> ExternResult<ActionHash> {
    if store(&input.catalog_ref)?.owner != me()? {
        return Err(guest("Only the store's owner can give its points."));
    }
    if input.points == 0 || input.points > MAX_GRANT_POINTS {
        return Err(guest(format!("You can give between 1 and {MAX_GRANT_POINTS} points at a time.")));
    }
    grant(input.to, input.catalog_ref, input.points, GrantReason::Goodwill { note: input.note })
}

/// Whether the caller's store has granted `to` something `matches` since
/// `since`.
fn granted(to: &AgentPubKey, since: Timestamp, matches: impl Fn(&GrantReason) -> bool) -> ExternResult<bool> {
    let types = [EntryType::try_from(UnitEntryTypes::PointsGrant)?];
    mine(&types).since(since).any(|r| decode_or::<PointsGrant>(r).is_some_and(|g| &g.to == to && matches(&g.reason)))
}

/// The points an order (any version) spent, back to its customer -- the
/// store's app calls this as it gives the order's food back. `None` if the
/// order redeemed nothing, or they're back already. Safe to repeat.
#[hdk_extern]
pub fn restore_for_order(order: ActionHash) -> ExternResult<Option<ActionHash>> {
    let order = original_action_of(order)?;
    let Some(record) = get(order.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(placed) = OrderForRewards::of(&record) else { return Ok(None) };
    let Some(redemption) = placed.rewards.and_then(|r| r.redemption) else { return Ok(None) };
    if store(&placed.catalog_ref)?.owner != me()? || granted(&placed.requester, record.action().timestamp(), |r| matches!(r, GrantReason::Restore { order: o } if o == &order))? {
        return Ok(None);
    }
    if !food_given_back(&order)? {
        return Ok(None);
    }
    let Some(spent) = get(redemption, GetOptions::default())?.and_then(|r| decode_or::<PointsEntry>(&r)) else { return Ok(None) };
    let points = u32::try_from(spent.points).map_err(|_| guest("out of range"))?;
    grant(placed.requester, placed.catalog_ref, points, GrantReason::Restore { order: order.clone() }).map(Some)
}

/// Mirrors `ledger::HoldView` and `ledger::WaiverView`, as far as needed.
#[derive(Deserialize, Debug)]
struct HoldWire {
    hold: ActionHash,
    purpose: dispatch_types::HoldPurpose,
}

#[derive(Deserialize, Debug)]
struct WaiverWire {
    portion: dispatch_types::Portion,
    by: AgentPubKey,
}

fn ledger<I: Serialize + std::fmt::Debug, O: serde::de::DeserializeOwned + std::fmt::Debug>(function: &str, input: I) -> ExternResult<O> {
    match call(CallTargetCell::Local, "ledger", function.into(), None, input)? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e)),
        other => Err(guest(format!("{function}: {other:?}"))),
    }
}

/// Whether the caller -- the order's store -- gave its food back to the
/// customer: when the points it spent come back too.
fn food_given_back(order: &ActionHash) -> ExternResult<bool> {
    let holds: Vec<HoldWire> = ledger("holds_for_order", order.clone())?;
    let me = me()?;
    for hold in holds.into_iter().filter(|h| h.purpose == dispatch_types::HoldPurpose::Food) {
        let waivers: Vec<WaiverWire> = ledger("waivers_for_hold", hold.hold)?;
        if waivers.iter().any(|w| w.portion == dispatch_types::Portion::Food && w.by == me) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Collects every grant made to the caller that they haven't yet -- each in
/// a call of its own, so one that doesn't validate yet can't hold up the
/// rest. Returns how many.
#[hdk_extern]
pub fn collect_grants(_: ()) -> ExternResult<u32> {
    let mut count = 0;
    for link in get_links(LinkQuery::try_new(me()?, LinkTypes::AgentToGrant)?, GetStrategy::default())? {
        let Some(grant) = link.target.into_action_hash() else { continue };
        if collected(&grant, link.timestamp)? {
            continue;
        }
        if handshake_coordinator_support::isolated::<_, ActionHash>("collect_grant", grant).is_some() {
            count += 1;
        }
    }
    Ok(count)
}

/// Whether the caller has collected `grant`, linked at `linked_at` -- read
/// back only to an hour before then: the grant and its link are written in
/// one call, and its collection after both.
fn collected(grant: &ActionHash, linked_at: Timestamp) -> ExternResult<bool> {
    let since = Timestamp::from_micros(linked_at.as_micros().saturating_sub(3_600_000_000));
    mine(&points_entries()?).since(since).any(|r| decode_or::<PointsEntry>(r).is_some_and(|e| matches!(&e.kind, PointsKind::Gift { grant: g } if g == grant)))
}

/// Collects one grant made to the caller (`collect_grants`).
#[hdk_extern]
pub fn collect_grant(grant_ref: ActionHash) -> ExternResult<ActionHash> {
    let record = get(grant_ref.clone(), GetOptions::default())?.ok_or(guest("grant not found"))?;
    let grant: PointsGrant = decode_or(&record).ok_or(guest("that isn't a grant"))?;
    if grant.to != me()? {
        return Err(guest("that grant is someone else's"));
    }
    let Ok(program) = program_at(&grant.program, &grant.catalog_ref)? else { return Err(guest("that grant's program is gone")) };
    let (hash, _) = append(&grant.catalog_ref, PointsKind::Gift { grant: grant_ref }, &program, Event::Credit { at: sys_time()?, points: u64::from(grant.points) })?;
    Ok(hash)
}

// --- birthdays ---

/// The caller's birth month, once set.
#[hdk_extern]
pub fn my_birth_month(_: ()) -> ExternResult<Option<u8>> {
    let types = [EntryType::try_from(UnitEntryTypes::BirthMonth)?];
    Ok(mine(&types).latest()?.and_then(|r| decode_or::<BirthMonth>(&r)).map(|b| b.month))
}

/// Sets the caller's birth month -- once, ever -- and tells every store
/// they're a member of.
#[hdk_extern]
pub fn set_birth_month(month: u8) -> ExternResult<()> {
    if my_birth_month(())?.is_some() {
        return Err(guest("Your birthday month is already set."));
    }
    if !(1..=12).contains(&month) {
        return Err(guest("Choose a month."));
    }
    create_entry(&EntryTypes::BirthMonth(BirthMonth { month }))?;
    let mut stores: Vec<ActionHash> = my_entries()?.into_iter().map(|(_, _, e)| e.catalog_ref).collect();
    stores.sort();
    stores.dedup();
    for store in stores {
        link_birthday(&store)?;
    }
    Ok(())
}

/// Tells a store the caller's birth month, if it's set and the store
/// hasn't been told.
fn link_birthday(catalog_ref: &ActionHash) -> ExternResult<()> {
    let types = [EntryType::try_from(UnitEntryTypes::BirthMonth)?];
    let Some(month) = mine(&types).latest()? else { return Ok(()) };
    let query = LinkQuery::try_new(catalog_ref.clone(), LinkTypes::CatalogToBirthday)?.author(me()?);
    if get_links(query, GetStrategy::Local)?.is_empty() {
        create_link(catalog_ref.clone(), month.action_address().clone(), LinkTypes::CatalogToBirthday, ())?;
    }
    Ok(())
}

/// How long a member must have earned at a store before it celebrates
/// them: a fresh account set up for the birthday alone gets nothing.
const BIRTHDAY_AFTER_DAYS: i64 = 30;

/// The caller's stores giving their birthday points to members whose month
/// it is: once a year each, to members who've ordered there for a while.
/// Returns how many it gave. Run on a schedule.
#[hdk_extern]
pub fn celebrate_birthdays(_: ()) -> ExternResult<u32> {
    let types = [EntryType::try_from(UnitEntryTypes::RewardsProgram)?];
    let now = sys_time()?;
    let a_year_ago = Timestamp::from_micros(now.as_micros() - 366 * 86_400_000_000);
    let mut given = 0;
    for original in mine(&types).creates().records()? {
        let Some(program) = decode_or::<RewardsProgram>(&original) else { continue };
        let Some(current) = my_current_version(original.action_address().clone())? else { continue };
        let Some(program) = decode_or::<RewardsProgram>(&current.record).filter(|p| p.active && p.birthday_points > 0 && p.catalog_ref == program.catalog_ref) else { continue };
        let local = local_time(now, &program.time_zone);
        for link in get_links(LinkQuery::try_new(program.catalog_ref.clone(), LinkTypes::CatalogToBirthday)?, GetStrategy::default())? {
            let member = link.author.clone();
            let Some(month) = link.target.into_action_hash().and_then(|h| get(h, GetOptions::default()).ok().flatten()).and_then(|r| decode_or::<BirthMonth>(&r)) else { continue };
            if month.month != local.month || granted(&member, a_year_ago, |r| matches!(r, GrantReason::Birthday { year } if *year == local.year))? {
                continue;
            }
            // A member who's earned here, the first time a while ago.
            let earned = get_links(LinkQuery::try_new(program.catalog_ref.clone(), LinkTypes::CatalogToMember)?.author(member.clone()), GetStrategy::default())?;
            let since = earned.iter().map(|l| l.timestamp).min();
            if !since.is_some_and(|first| now.as_micros() - first.as_micros() >= BIRTHDAY_AFTER_DAYS * 86_400_000_000) {
                continue;
            }
            if handshake_coordinator_support::isolated::<_, ActionHash>("grant_birthday", BirthdayInput { to: member, catalog_ref: program.catalog_ref.clone(), points: program.birthday_points, year: local.year }).is_some() {
                given += 1;
            }
        }
    }
    Ok(given)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct BirthdayInput {
    pub to: AgentPubKey,
    pub catalog_ref: ActionHash,
    pub points: u32,
    pub year: i32,
}

/// One birthday grant (`celebrate_birthdays`).
#[hdk_extern]
pub fn grant_birthday(input: BirthdayInput) -> ExternResult<ActionHash> {
    if store(&input.catalog_ref)?.owner != me()? {
        return Err(guest("not this store's owner"));
    }
    grant(input.to, input.catalog_ref, input.points, GrantReason::Birthday { year: input.year })
}

/// Celebrates birthdays and collects any grants, a few times a day,
/// whether or not the app is open. Scheduled at `init`.
#[hdk_extern(infallible)]
pub fn rewards_periodically(_: Option<Schedule>) -> Option<Schedule> {
    let _ = celebrate_birthdays(());
    let _ = collect_grants(());
    let _ = reclaim_unspent(());
    Some(Schedule::Persisted("0 7 */3 * * * *".into()))
}

#[hdk_extern]
pub fn init() -> ExternResult<InitCallbackResult> {
    prepare_device(())?;
    Ok(InitCallbackResult::Pass)
}

/// This device's background work, set up if it isn't (see dispatch's
/// `prepare_device`).
#[hdk_extern]
pub fn prepare_device(_: ()) -> ExternResult<()> {
    schedule("rewards_periodically")?;
    Ok(())
}

// --- a store's view ---

/// How a store's program is doing, from its members' own links.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct ProgramStats {
    /// Members who've earned here.
    pub members: u32,
    /// Of them, those who earned in the last 30 days.
    pub active_members: u32,
    pub points_earned: u64,
    pub redemptions: u32,
}

#[hdk_extern]
pub fn program_stats(catalog_ref: ActionHash) -> ExternResult<ProgramStats> {
    let now = sys_time()?.as_micros();
    let mut members: Vec<(AgentPubKey, bool)> = Vec::new();
    let mut stats = ProgramStats::default();
    for link in get_links(LinkQuery::try_new(catalog_ref.clone(), LinkTypes::CatalogToMember)?, GetStrategy::default())? {
        let points = <[u8; 8]>::try_from(link.tag.0.as_slice()).map(u64::from_be_bytes).unwrap_or(0);
        stats.points_earned = stats.points_earned.saturating_add(points);
        let recent = now - link.timestamp.as_micros() <= 30 * 86_400_000_000;
        match members.iter_mut().find(|(m, _)| m == &link.author) {
            Some((_, active)) => *active |= recent,
            None => members.push((link.author, recent)),
        }
    }
    stats.members = members.len() as u32;
    stats.active_members = members.iter().filter(|(_, active)| *active).count() as u32;
    stats.redemptions = get_links(LinkQuery::try_new(catalog_ref, LinkTypes::CatalogToRedemption)?, GetStrategy::default())?.len() as u32;
    Ok(stats)
}

#[cfg(feature = "test-utils")]
mod test_utils {
    use super::*;

    /// Writes a points entry exactly as given -- a forgery a modified app
    /// would try, for validation tests.
    #[hdk_extern]
    pub fn create_raw_points_entry_for_testing(entry: PointsEntry) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::PointsEntry(entry))
    }

    /// The same for a grant, and a program.
    #[hdk_extern]
    pub fn create_raw_points_grant_for_testing(grant: PointsGrant) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::PointsGrant(grant))
    }

    #[hdk_extern]
    pub fn create_raw_program_for_testing(program: RewardsProgram) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::RewardsProgram(program))
    }

    handshake_coordinator_support::raw_link_test_externs!(CatalogToProgram, CatalogToMember, CatalogToRedemption, AgentToGrant, CatalogToBirthday);
}
