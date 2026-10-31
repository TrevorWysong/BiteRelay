//! Integrity zome for stores' rewards programs and their members' points.
//! See `rewards_types` for the model, and docs/REWARDS.md.
//!
//! What validation guarantees:
//!
//! - **A program is its store's.** Only the store's owner writes it, once,
//!   and changes it by updating it; everything it names is on that store's
//!   menu, and every limit holds (`RewardsProgram::problem`).
//! - **A balance is the arithmetic of its member's own chain.** Each entry
//!   follows their previous one at that store, none skipped, and its state
//!   -- balance, tier years, expiry -- is exactly what the shared rules
//!   (`rewards_types::points`) make of it. Nobody states their own.
//! - **Points come only from what was paid, or from the store.** Earning
//!   cites the member's own order, placed under an active version of the
//!   program, and the store's settlement of it; once per order, dated by
//!   the settlement. A grant is the store owner's own, collected once.
//! - **Points are spent only on a reward the member may have.** At a
//!   running version of the program, for its exact cost, at the tier it
//!   needs -- and each redemption pays for one order (`dispatch_integrity`).

use handshake_integrity_support::chain::{entries_since, entry_of, ever_created, walk_back};
use handshake_integrity_support::{classify, decode, invalid, linked_record, original_creation, require, valid, Checked};
use hdi::prelude::*;
pub use rewards_types::*;
use catalog_types::{MenuItem, MerchantCatalog};
use core::ops::ControlFlow;

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    RewardsProgram(RewardsProgram),
    PointsEntry(PointsEntry),
    PointsGrant(PointsGrant),
    BirthMonth(BirthMonth),
}

#[hdk_link_types]
pub enum LinkTypes {
    /// An entry's update, base = its original, tagged with how deep it is
    /// (`handshake_integrity_support::versions`). First in every zome.
    Version,
    /// A store's program, base = the store.
    CatalogToProgram,
    /// A member's earning at a store, base = the store, tagged with the
    /// points -- how a store sees its members.
    CatalogToMember,
    /// A member's redemption at a store, base = the store.
    CatalogToRedemption,
    /// A store's grant, base = whoever it's to, so they find it.
    AgentToGrant,
    /// A member's birth month, base = a store they belong to, so its app
    /// finds whom to celebrate.
    CatalogToBirthday,
}

const _: () = assert!(LinkTypes::Version as u8 == handshake_integrity_support::versions::VERSION_LINK_TYPE, "Version must be the first link type");

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match classify(op.flattened::<EntryTypes, LinkTypes>()?)? {
        Checked::Create { entry, action } => match entry {
            EntryTypes::RewardsProgram(program) => validate_new_program(&program, action.author(), action.prev_action()),
            EntryTypes::PointsEntry(entry) => validate_points(&entry, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::PointsGrant(grant) => validate_grant(&grant, action.author(), action.timestamp()),
            EntryTypes::BirthMonth(month) => validate_birth_month(&month, action.author(), action.prev_action()),
        },
        Checked::Update { entry: EntryTypes::RewardsProgram(program), action } => validate_program_update(&program, action.author(), &action.original_action_address),
        Checked::Update { .. } => invalid("points, grants and birth months can't be changed"),
        Checked::Delete { .. } => invalid("rewards records can't be deleted"),
        Checked::CreateLink { link_type: LinkTypes::Version, action } => handshake_integrity_support::versions::validate_version_link(&action.base_address, &action.target_address, &action.tag, action.author()),
        Checked::CreateLink { link_type, action } => validate_create_link(link_type, &action.base_address, &action.target_address, &action.tag, action.author()),
        Checked::DeleteLink { .. } => invalid("rewards links can't be deleted"),
        Checked::Other => valid(),
    }
}

// --- programs ---

/// The owner of the store `catalog_ref` names (its original action), if it
/// is one.
fn store_owner(catalog_ref: &ActionHash) -> ExternResult<Option<(AgentPubKey, Timestamp)>> {
    if &original_creation(catalog_ref.clone())? != catalog_ref {
        return Ok(None);
    }
    let record = must_get_valid_record(catalog_ref.clone())?;
    Ok(decode::<MerchantCatalog>(&record).map(|store| (store.owner, record.action().timestamp())))
}

/// A program's limits, and that everything it names is on its store's menu,
/// by the item's identity.
fn check_program(program: &RewardsProgram) -> ExternResult<Option<String>> {
    if let Some(problem) = program.problem() {
        return Ok(Some(problem));
    }
    for item_ref in program.items() {
        if &original_creation(item_ref.clone())? != item_ref {
            return Ok(Some("a program names an item by its original action".into()));
        }
        let ours = decode::<MenuItem>(&must_get_valid_record(item_ref.clone())?).is_some_and(|item| item.catalog_ref == program.catalog_ref);
        if !ours {
            return Ok(Some("a program names only its own store's items".into()));
        }
    }
    Ok(None)
}

fn validate_new_program(program: &RewardsProgram, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some((owner, opened)) = store_owner(&program.catalog_ref)? else { return invalid("a program is for a store, by its original action") };
    if &owner != author {
        return invalid("only a store's owner runs its program");
    }
    if let Some(problem) = check_program(program)? {
        return invalid(&problem);
    }
    let Some(prev) = prev_action else { return invalid("a program can't open a chain") };
    // Once per store: every later change is an update of it.
    let again = handshake_integrity_support::chain::wrote_since(author, prev, opened, UnitEntryTypes::RewardsProgram.try_into()?, |p: &RewardsProgram| p.catalog_ref == program.catalog_ref)?;
    require(!again, "a store has one program; change it by updating it")
}

fn validate_program_update(program: &RewardsProgram, author: &AgentPubKey, original: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let prior_record = must_get_valid_record(original.clone())?;
    let Some(prior) = decode::<RewardsProgram>(&prior_record) else { return invalid("a program updates a program") };
    if prior_record.action().author() != author || prior.catalog_ref != program.catalog_ref {
        return invalid("only its owner changes a program, and it stays with its store");
    }
    match check_program(program)? {
        Some(problem) => invalid(&problem),
        None => valid(),
    }
}

// --- points ---

fn points_type() -> ExternResult<ScopedEntryDefIndex> {
    UnitEntryTypes::PointsEntry.try_into()
}

/// The points entry an action in a walk wrote, if it wrote one.
fn points_of(item: &AgentActivity) -> ExternResult<Option<PointsEntry>> {
    let action = &item.action.hashed.content;
    if !handshake_integrity_support::chain::creates_one_of(action, &[points_type()?]) {
        return Ok(None);
    }
    let Some(entry_hash) = action.entry_hash() else { return Ok(None) };
    let Entry::App(bytes) = entry_of(item, entry_hash)? else { return Ok(None) };
    Ok(PointsEntry::try_from(SerializedBytes::from(bytes)).ok())
}

/// Where the member stood at this store before `entry`: their previous
/// entry there, which must be their latest -- `None` if this is their
/// first, which it must then be.
fn prior_state(entry: &PointsEntry, author: &AgentPubKey, prev_action: &ActionHash) -> ExternResult<Result<Option<PointsState>, &'static str>> {
    match &entry.previous {
        Some(previous) => {
            let record = must_get_valid_record(previous.clone())?;
            let Some(prior) = decode::<PointsEntry>(&record) else { return Ok(Err("previous must be a points entry")) };
            if record.action().author() != author || prior.catalog_ref != entry.catalog_ref {
                return Ok(Err("previous must be the member's own entry at this store"));
            }
            for item in must_get_agent_activity(author.clone(), ChainFilter::until_hash(prev_action.clone(), previous.clone()))? {
                if &item.action.hashed.hash != previous && points_of(&item)?.is_some_and(|e| e.catalog_ref == entry.catalog_ref) {
                    return Ok(Err("previous must be the member's latest entry at this store"));
                }
            }
            Ok(Ok(Some(prior.state)))
        }
        None => {
            let mut earlier = false;
            walk_back(author, prev_action, |item| {
                earlier = points_of(&item)?.is_some_and(|e| e.catalog_ref == entry.catalog_ref);
                Ok(if earlier { ControlFlow::Break(()) } else { ControlFlow::Continue(()) })
            })?;
            Ok(if earlier { Err("previous must name the member's latest entry at this store") } else { Ok(None) })
        }
    }
}

/// Whether `author` wrote a points entry matching `matches` from
/// `prev_action` back to `since`.
fn wrote_points(author: &AgentPubKey, prev_action: &ActionHash, since: Timestamp, matches: impl Fn(&PointsEntry) -> bool) -> ExternResult<bool> {
    Ok(entries_since(author, prev_action, since, &[points_type()?])?.into_iter().any(|bytes| PointsEntry::try_from(bytes).is_ok_and(|e| matches(&e))))
}

fn validate_points(entry: &PointsEntry, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(prev_action) = prev_action else { return invalid("a points entry can't open a chain") };
    let prior = match prior_state(entry, author, prev_action)? {
        Ok(prior) => prior,
        Err(reason) => return invalid(reason),
    };
    let (program, event) = match &entry.kind {
        PointsKind::Earn { order, settlement, accepted, ruling } => {
            let earning = match earning(order, settlement, accepted, ruling.as_ref())? {
                Ok(earning) => earning,
                Err(reason) => return invalid(reason),
            };
            if &earning.order.requester != author || earning.order.catalog_ref != entry.catalog_ref {
                return invalid("points are earned by the order's own customer, at its store");
            }
            // Only once the refund period is over: nobody can date an entry
            // ahead of now, so this one was written after it -- and an
            // appeal must come within it, so every appeal there will ever
            // be is already on the customer's chain, before this.
            let ended = if earning.available_at > earning.settled_at { at > earning.available_at } else { at >= earning.settled_at };
            if !ended {
                return invalid("points are earned once the order's refund period is over");
            }
            let appealed = appeal_of(author, prev_action, earning.settled_at, order)?;
            let cited = ruling.as_ref().map(|r| decode::<dispatch_types::Ruling>(&must_get_valid_record(r.clone())?).map(|r| r.appeal).ok_or(wasm_error!(WasmErrorInner::Guest("not a ruling".into())))).transpose()?;
            if appealed != cited {
                return invalid("an appealed order earns on its arbiter's ruling, and only an appealed one");
            }
            let placed = must_get_action(order.clone())?.hashed.content.timestamp();
            if wrote_points(author, prev_action, placed, |e| matches!(&e.kind, PointsKind::Earn { order: o, .. } if o == order))? {
                return invalid("an order earns once");
            }
            (earning.program, Event::Earn { at: earning.settled_at, base: earning.base })
        }
        PointsKind::Redeem { program: program_ref, reward } => {
            let program = match program_at(program_ref, &entry.catalog_ref)? {
                Ok(program) => program,
                Err(reason) => return invalid(reason),
            };
            if !program.active {
                return invalid("rewards are redeemed while the program runs");
            }
            let Some(reward) = program.reward(*reward) else { return invalid("that program has no such reward") };
            let event = Event::Spend { at, cost: u64::from(reward.cost), min_tier: reward.min_tier };
            (program, event)
        }
        PointsKind::Gift { grant: grant_ref } => {
            let record = must_get_valid_record(grant_ref.clone())?;
            let Some(grant) = decode::<PointsGrant>(&record) else { return invalid("a gift collects a store's grant") };
            if &grant.to != author || grant.catalog_ref != entry.catalog_ref {
                return invalid("a gift collects a grant to its author, at its store");
            }
            let granted_at = record.action().timestamp();
            if at < granted_at {
                return invalid("a grant is collected after it's made");
            }
            if wrote_points(author, prev_action, granted_at, |e| matches!(&e.kind, PointsKind::Gift { grant } if grant == grant_ref))? {
                return invalid("a grant is collected once");
            }
            let program = match program_at(&grant.program, &entry.catalog_ref)? {
                Ok(program) => program,
                Err(reason) => return invalid(reason),
            };
            (program, Event::Credit { at, points: u64::from(grant.points) })
        }
        // An order cites its redemption from the member's own chain,
        // placed within the window after it -- so once the window's passed
        // (this entry dated after it, and every later action after this),
        // a walk back to the redemption sees every order that ever could.
        PointsKind::Unspend { redemption } => {
            let record = must_get_valid_record(redemption.clone())?;
            let spent = decode::<PointsEntry>(&record).filter(|e| record.action().author() == author && e.catalog_ref == entry.catalog_ref);
            let Some(PointsEntry { kind: PointsKind::Redeem { program: program_ref, .. }, points, .. }) = spent else { return invalid("points come back only from the member's own redemption, at this store") };
            let redeemed_at = record.action().timestamp();
            if at.as_micros() <= redeemed_at.as_micros() + REDEMPTION_WINDOW_SECS * 1_000_000 {
                return invalid("a redemption comes back only once its window has passed");
            }
            if wrote_points(author, prev_action, redeemed_at, |e| matches!(&e.kind, PointsKind::Unspend { redemption: r } if r == redemption))? {
                return invalid("a redemption comes back once");
            }
            let order_types = [dispatch_order_type("DeliveryOrder")?, dispatch_order_type("PickupOrder")?];
            if order_types.iter().any(Option::is_none) {
                return invalid("this network has no orders to check");
            }
            let order_types: Vec<ScopedEntryDefIndex> = order_types.into_iter().flatten().collect();
            let cites = |bytes: SerializedBytes| {
                let cited = dispatch_types::DeliveryOrder::try_from(bytes.clone()).ok().and_then(|o| o.rewards).or_else(|| dispatch_types::PickupOrder::try_from(bytes).ok().and_then(|o| o.rewards));
                cited.and_then(|r| r.redemption).as_ref() == Some(redemption)
            };
            if entries_since(author, prev_action, redeemed_at, &order_types)?.into_iter().any(cites) {
                return invalid("that redemption paid for an order; its points come back only from the store");
            }
            let program = match program_at(&program_ref, &entry.catalog_ref)? {
                Ok(program) => program,
                Err(reason) => return invalid(reason),
            };
            (program, Event::Credit { at, points })
        }
    };
    match step(&program, prior.as_ref(), event) {
        Ok((state, points)) if state == entry.state && points == entry.points => valid(),
        Ok(_) => invalid("a points entry's points and state must follow from the member's previous one"),
        Err(reason) => invalid(reason),
    }
}

/// The member's appeal of `order`, if they made one, from `chain_top` back
/// to `since` (the settlement it appeals): its action.
fn appeal_of(author: &AgentPubKey, chain_top: &ActionHash, since: Timestamp, order: &ActionHash) -> ExternResult<Option<ActionHash>> {
    let Some(appeal_type) = dispatch_order_type("Appeal")? else { return Ok(None) };
    for item in handshake_integrity_support::chain::activity_since(author, chain_top, since)? {
        let action = &item.action.hashed.content;
        if !handshake_integrity_support::chain::creates_one_of(action, &[appeal_type]) {
            continue;
        }
        let Some(entry_hash) = action.entry_hash() else { continue };
        let Entry::App(bytes) = entry_of(&item, entry_hash)? else { continue };
        if dispatch_types::Appeal::try_from(SerializedBytes::from(bytes)).is_ok_and(|a| &a.order == order) {
            return Ok(Some(item.action.hashed.hash.clone()));
        }
    }
    Ok(None)
}

/// The dispatch zome's entry type `name` -- found by the zome's name in
/// this DNA, so a walk can pick out its orders.
/// Its indexes are asserted in `dispatch_integrity`.
pub fn dispatch_order_type(name: &str) -> ExternResult<Option<ScopedEntryDefIndex>> {
    let Some(zome) = dna_info()?.zome_names.iter().position(|z| z.0 == "dispatch_integrity") else { return Ok(None) };
    let index = match name {
        "DeliveryOrder" => 0,
        "PickupOrder" => 3,
        "Appeal" => 11,
        _ => return Ok(None),
    };
    Ok(Some(ScopedEntryDefIndex { zome_index: ZomeIndex(zome as u8), zome_type: EntryDefIndex(index) }))
}

// --- grants ---

fn validate_grant(grant: &PointsGrant, author: &AgentPubKey, at: Timestamp) -> ExternResult<ValidateCallbackResult> {
    let Some((owner, _)) = store_owner(&grant.catalog_ref)? else { return invalid("a grant is a store's, by its original action") };
    if &owner != author {
        return invalid("only a store's owner grants its points");
    }
    if &grant.to == author {
        return invalid("a store grants points to others");
    }
    let program = match program_at(&grant.program, &grant.catalog_ref)? {
        Ok(program) => program,
        Err(reason) => return invalid(reason),
    };
    if grant.points == 0 || grant.points > MAX_GRANT_POINTS {
        return invalid(&format!("a grant is between 1 and {MAX_GRANT_POINTS} points"));
    }
    match &grant.reason {
        GrantReason::Goodwill { note } => match handshake_integrity_support::text_problem("note", note, MAX_GRANT_NOTE_CHARS) {
            Some(problem) => invalid(&problem),
            None => valid(),
        },
        // What a redemption spent, back to whoever spent it.
        GrantReason::Restore { order } => {
            let record = must_get_valid_record(order.clone())?;
            let Some(placed) = OrderForRewards::of(&record).filter(|_| matches!(record.action().data, ActionData::Create(_))) else {
                return invalid("points come back for an order, by its original action");
            };
            let Some(redemption) = placed.rewards.and_then(|r| r.redemption) else { return invalid("that order redeemed nothing") };
            let redeemed = decode::<PointsEntry>(&must_get_valid_record(redemption)?);
            let spent = redeemed.filter(|e| matches!(e.kind, PointsKind::Redeem { .. })).map(|e| e.points);
            require(placed.catalog_ref == grant.catalog_ref && placed.requester == grant.to && spent == Some(u64::from(grant.points)), "points come back to whoever spent them, as many as they spent, at that store")
        }
        GrantReason::Birthday { year } => require(local_time(at, &program.time_zone).year == *year, "a birthday is this year's"),
    }
}

fn validate_birth_month(month: &BirthMonth, author: &AgentPubKey, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    if !(1..=12).contains(&month.month) {
        return invalid("a birth month is between 1 and 12");
    }
    let Some(prev) = prev_action else { return invalid("a birth month can't open a chain") };
    let set = ever_created(author, prev, &[UnitEntryTypes::BirthMonth.try_into()?])?;
    require(!set, "a birth month is set once")
}

// --- links ---

fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, tag: &LinkTag, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let Some(record) = linked_record(target)? else { return invalid("rewards links target a record") };
    if record.action().author() != author {
        return invalid("a rewards link is made by whoever wrote what it points at");
    }
    let expected: Option<AnyLinkableHash> = match link_type {
        LinkTypes::Version => return invalid("a version link is validated as one"),
        LinkTypes::CatalogToProgram => decode::<RewardsProgram>(&record).filter(|_| matches!(record.action().data, ActionData::Create(_))).map(|p| p.catalog_ref.into()),
        LinkTypes::CatalogToMember => match decode::<PointsEntry>(&record) {
            Some(e) if matches!(e.kind, PointsKind::Earn { .. }) => {
                if tag.0 != e.points.to_be_bytes() {
                    return invalid("a member's link is tagged with what they earned");
                }
                Some(e.catalog_ref.into())
            }
            _ => None,
        },
        LinkTypes::CatalogToRedemption => decode::<PointsEntry>(&record).filter(|e| matches!(e.kind, PointsKind::Redeem { .. })).map(|e| e.catalog_ref.into()),
        LinkTypes::AgentToGrant => decode::<PointsGrant>(&record).map(|g| g.to.into()),
        LinkTypes::CatalogToBirthday => match decode::<BirthMonth>(&record) {
            Some(_) => {
                let store = base.clone().into_action_hash().map(|hash| store_owner(&hash)).transpose()?.flatten();
                return require(store.is_some(), "a birthday is linked from a store");
            }
            None => None,
        },
    };
    match expected {
        Some(expected) => require(&expected == base, "a rewards link sits under the store or member its record is about"),
        None => invalid("a rewards link's target is not the record its link type indexes"),
    }
}
