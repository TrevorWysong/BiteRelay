//! Integrity zome for the ledger: escrowed payments for orders, validated
//! on each agent's own chain.
//!
//! What validation guarantees:
//!
//! - **A balance is the arithmetic of its owner's own chain.** Every entry
//!   says what it leaves its author with and points at their previous
//!   entry; validation walks the author's chain to check nothing between
//!   them was skipped and the sum holds. Nobody can state a balance, hide a
//!   debit, or mint money -- funds enter only from an issuer on the DNA's
//!   roster (`IssuerGrant`).
//! - **Money for an order is held before it's needed.** A hold is priced
//!   from the order's fixed terms (`dispatch_types::settlement`), paid by
//!   whoever owes it, and can't take a balance below the DNA's credit limit
//!   -- so with a limit of 0, an identity with nothing in it can't order.
//!   Each step of an order cites its hold (`dispatch_integrity`): a store
//!   can't accept an order whose food isn't paid for.
//! - **Each part of a hold is paid out once, on one decision.** Once an
//!   order is out of the kitchen, everything moves on the store's single
//!   decision about it (`dispatch_types::issues`): its outcome (delivered,
//!   or not) and its settlement of the food. The store can write each only
//!   once, so no two payments can rest on contradictory decisions. Before
//!   that, a cancellation settles what the canceller owes, and a recipient
//!   can always waive a part back. Each party decides each part once --
//!   entries on their own chain, which validation walks.
//!
//! - **A driver carries a bounded number of orders.** Every entry carries
//!   the orders its author has in hand (`InHand`), checked against their
//!   previous entry like the balance: picking one up (its collateral hold)
//!   adds one -- refused past the network's `max_concurrent_deliveries`, or
//!   alongside a priority order, which goes alone -- and settling it (the
//!   collateral back, or forfeited on the store's decision) takes one away.
//!
//! - **Money leaves only as money that's there.** A cash-out (`Redeem`)
//!   names an issuer on the roster, is at least the network's minimum, and
//!   can't take its author below zero, whatever the credit limit: credit is
//!   never cashed out. Its issuer writes its outcome once -- paid, or
//!   declined -- and only a declined one comes back to its author, once.
//!
//! What it can't: move money nobody is entitled to collect yet. An order
//! nobody has decided stays held. Nor make an issuer pay: what an issuer
//! does outside the network rests on its public record of outcomes, and on
//! the roster that names it.

use dispatch_types::lineage::{self, Version};
use dispatch_types::{hold_amount, hold_terms, Bid, Cancellation, DeliveryOrder, DeliveryStatus, ItemSettlement, OrderOutcome, OrderTerms, Outcome, PickupOrder, PickupStatus, Share};
use hdi::prelude::*;
pub use ledger_types::*;
use catalog_types::{listing_tag, MerchantCatalog, CATALOG_INTEGRITY_ZOME};
use relay_integrity_support::{classify, decode, first_problem, invalid, linked_record, original_creation, require, text_problem, valid, Checked};

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    LedgerEntry(LedgerEntry),
    IssuerGrant(IssuerGrant),
    RedemptionOutcome(RedemptionOutcome),
    IssuerProfile(IssuerProfile),
}

#[hdk_link_types]
pub enum LinkTypes {
    /// An entry's update, base = its original, tagged with how deep it is --
    /// how its current version is found in one read
    /// (`relay_integrity_support::versions`). First in every zome.
    Version,
    /// An order's holds, so its parties can find what they're owed.
    OrderToHold,
    /// A hold's waivers, so its payer can find what's returned to them.
    HoldToWaive,
    /// An agent's grants, so they can collect them. Tagged with the grant's
    /// reference, so its issuer finds a payment it already granted.
    AgentToGrant,
    /// The cash-outs an issuer is asked to pay, base = the issuer -- swept by
    /// its service in the order they arrive (`LinkQuery::after`).
    IssuerToRedemption,
    /// A cash-out's outcome, base = the cash-out, so its author finds it.
    RedemptionToOutcome,
    /// An issuer's profile, base = the issuer.
    IssuerToProfile,
    /// A grant's collection, base = the grant, so its recipient knows it's
    /// collected without reading back through their ledger.
    GrantToDeposit,
}

const _: () = assert!(LinkTypes::Version as u8 == relay_integrity_support::versions::VERSION_LINK_TYPE, "Version must be the first link type");

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match classify(op.flattened::<EntryTypes, LinkTypes>()?)? {
        Checked::Create { entry, action } => match entry {
            EntryTypes::LedgerEntry(entry) => validate_entry(&entry, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::IssuerGrant(grant) => validate_grant(&grant, action.author()),
            EntryTypes::RedemptionOutcome(outcome) => validate_outcome(&outcome, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::IssuerProfile(profile) => validate_issuer_profile(&profile, action.author()),
        },
        // An issuer keeps its profile current; nothing else changes.
        Checked::Update { entry: EntryTypes::IssuerProfile(profile), action } => {
            let prior = must_get_valid_record(action.original_action_address.clone())?;
            if decode::<IssuerProfile>(&prior).is_none() || prior.action().author() != action.author() {
                return invalid("an issuer changes only its own profile");
            }
            validate_issuer_profile(&profile, action.author())
        }
        Checked::Update { .. } => invalid("ledger entries can't be changed"),
        Checked::Delete { .. } => invalid("ledger entries can't be deleted"),
        Checked::CreateLink { link_type: LinkTypes::Version, action } => relay_integrity_support::versions::validate_version_link(&action.base_address, &action.target_address, &action.tag, action.author()),
        Checked::DeleteLink { link_type: LinkTypes::Version, .. } => Ok(ValidateCallbackResult::Invalid("an entry's versions stay linked".into())),
        Checked::CreateLink { link_type, action } => validate_create_link(link_type, &action.base_address, &action.target_address, &action.tag, action.author()),
        Checked::DeleteLink { .. } => invalid("ledger links can't be deleted"),
        Checked::Other => valid(),
    }
}

fn validate_grant(grant: &IssuerGrant, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if !relay_governance::is_issuer(author)? {
        return invalid("only an issuer on the network's roster may issue funds");
    }
    if grant.amount == 0 || grant.reference.trim().is_empty() {
        return invalid("a grant must be for something, with the issuer's reference");
    }
    if let Some(problem) = relay_integrity_support::amount_problem("amount", grant.amount) {
        return invalid(&problem);
    }
    match first_problem([text_problem("reference", &grant.reference, relay_integrity_support::limits::MAX_REFERENCE_CHARS)]) {
        Some(problem) => Ok(problem),
        None => valid(),
    }
}

fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, tag: &LinkTag, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let Some(record) = linked_record(target)? else {
        return invalid("ledger links must target a record");
    };
    if author != record.action().author() {
        return invalid("a ledger link must be authored by the author of the entry it indexes");
    }
    let expected: Option<AnyLinkableHash> = match link_type {
        // Validated as a version (`validate`).
        LinkTypes::Version => return invalid("a version link is validated as one"),
        LinkTypes::OrderToHold => match decode::<LedgerEntry>(&record).map(|e| e.kind) {
            Some(LedgerKind::Hold { order, .. }) => Some(order.into()),
            _ => None,
        },
        LinkTypes::HoldToWaive => match decode::<LedgerEntry>(&record).map(|e| e.kind) {
            Some(LedgerKind::Waive { hold, .. }) => Some(hold.into()),
            _ => None,
        },
        LinkTypes::AgentToGrant => match decode::<IssuerGrant>(&record) {
            Some(grant) if tag.0 != grant.reference.as_bytes() => return invalid("a grant's link is tagged with its reference"),
            grant => grant.map(|grant| grant.to.into()),
        },
        LinkTypes::GrantToDeposit => match decode::<LedgerEntry>(&record).map(|e| e.kind) {
            Some(LedgerKind::Deposit { grant }) => Some(grant.into()),
            _ => None,
        },
        LinkTypes::IssuerToRedemption => match decode::<LedgerEntry>(&record).map(|e| e.kind) {
            Some(LedgerKind::Redeem { issuer, .. }) => Some(issuer.into()),
            _ => None,
        },
        LinkTypes::RedemptionToOutcome => decode::<RedemptionOutcome>(&record).map(|o| o.redemption.into()),
        LinkTypes::IssuerToProfile => decode::<IssuerProfile>(&record).filter(|_| matches!(record.action().data, ActionData::Create(_))).map(|_| author.clone().into()),
    };
    match expected {
        Some(expected) => require(&expected == base, "a ledger link must sit under the order, hold, grant or agent its entry is about"),
        None => invalid("a ledger link's target is not the entry its link type indexes"),
    }
}

/// One ledger action on an agent's chain, as walked by validation.
struct ChainEntry {
    hash: ActionHash,
    entry: LedgerEntry,
}

fn is_ledger_entry(action: &Action) -> ExternResult<bool> {
    let ActionData::Create(create) = &action.data else { return Ok(false) };
    Ok(create.entry_type == EntryType::try_from(UnitEntryTypes::LedgerEntry)?)
}

/// Every ledger entry on `agent`'s chain from `chain_top` back to the first
/// action at or after `since`, newest first -- none if the chain hadn't
/// reached `since` yet.
fn ledger_since(agent: &AgentPubKey, chain_top: &ActionHash, since: Timestamp) -> ExternResult<Vec<ChainEntry>> {
    Ok(ledger_of(relay_integrity_support::chain::activity_since(agent, chain_top, since)?)?.0)
}

/// The same, and whether the walk passed the chain's close (`close_chain`,
/// moving the account to another network) -- after which nothing more moves
/// money here. Holochain's own check of that runs only where the agent's
/// activity is held, not where a record is: a counterparty must_get-ing a
/// hold wouldn't see it. So the ledger checks for itself.
fn ledger_walk(agent: &AgentPubKey, filter: ChainFilter) -> ExternResult<(Vec<ChainEntry>, bool)> {
    ledger_of(must_get_agent_activity(agent.clone(), filter)?)
}

/// The ledger entries among `activity`, and whether it holds the chain's close.
fn ledger_of(activity: Vec<AgentActivity>) -> ExternResult<(Vec<ChainEntry>, bool)> {
    let mut entries = Vec::new();
    let mut closed = false;
    for item in activity {
        let action = &item.action.hashed.content;
        if matches!(action.data, ActionData::CloseChain(_)) {
            closed = true;
            continue;
        }
        if !is_ledger_entry(action)? {
            continue;
        }
        let ActionData::Create(create) = &action.data else { continue };
        let Entry::App(bytes) = relay_integrity_support::chain::entry_of(&item, &create.entry_hash)? else { continue };
        let Ok(entry) = LedgerEntry::try_from(SerializedBytes::from(bytes)) else { continue };
        entries.push(ChainEntry { hash: item.action.hashed.hash.clone(), entry });
    }
    Ok((entries, closed))
}

fn validate_entry(entry: &LedgerEntry, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some(prev_action) = prev_action else { return invalid("a ledger entry can't open a chain") };

    // Its place on the author's chain: right after their previous entry.
    let prior = match &entry.previous {
        Some(previous) => {
            let record = must_get_valid_record(previous.clone())?;
            let Some(prior) = decode::<LedgerEntry>(&record) else { return invalid("previous must be a ledger entry") };
            if record.action().author() != author {
                return invalid("previous must be the author's own ledger entry");
            }
            let (between, closed) = ledger_walk(author, ChainFilter::until_hash(prev_action.clone(), previous.clone()))?;
            if between.iter().any(|e| &e.hash != previous) {
                return invalid("previous must be the author's latest ledger entry");
            }
            if closed {
                return invalid("this account's chain is closed: it moved to another network");
            }
            (prior.balance, prior.in_hand)
        }
        None => {
            // Its first: no ledger entry before it, read from the actions alone.
            let (mut earlier, mut closed) = (false, false);
            relay_integrity_support::chain::walk_back(author, prev_action, |item| {
                let action = &item.action.hashed.content;
                closed |= matches!(action.data, ActionData::CloseChain(_));
                earlier = is_ledger_entry(action)?;
                Ok(if earlier { core::ops::ControlFlow::Break(()) } else { core::ops::ControlFlow::Continue(()) })
            })?;
            if earlier {
                return invalid("previous must name the author's latest ledger entry");
            }
            if closed {
                return invalid("this account's chain is closed: it moved to another network");
            }
            (0, InHand::default())
        }
    };
    let (prior_balance, prior_in_hand) = prior;

    // The arithmetic, and the credit limit on what's spent.
    let amount = i128::from(entry.amount);
    let (expected, debit) = match &entry.kind {
        LedgerKind::Deposit { .. } | LedgerKind::Collect { .. } | LedgerKind::Unstake { .. } | LedgerKind::Reclaim { .. } => (i128::from(prior_balance) + amount, false),
        LedgerKind::Hold { .. } | LedgerKind::Stake { .. } => (i128::from(prior_balance) - amount, true),
        // Credit is never cashed out: only money the author has.
        LedgerKind::Redeem { .. } => {
            if i128::from(prior_balance) - amount < 0 {
                return invalid("a cash-out can't take a balance below zero");
            }
            (i128::from(prior_balance) - amount, true)
        }
        LedgerKind::Waive { .. } | LedgerKind::Forfeit { .. } => {
            if entry.amount != 0 {
                return invalid("waiving or forfeiting changes nothing in the author's own balance");
            }
            (i128::from(prior_balance), false)
        }
    };
    if i128::from(entry.balance) != expected {
        return invalid("a ledger entry's balance must follow from the author's previous one");
    }
    if debit && expected < -i128::from(relay_governance::credit_limit_cents()) {
        return invalid("that would take the balance past the network's credit limit");
    }

    let kind_result = match &entry.kind {
        LedgerKind::Deposit { grant } => validate_deposit(entry, grant, author, at, prev_action),
        LedgerKind::Hold { order, purpose } => validate_hold(entry, order, purpose, author),
        LedgerKind::Collect { hold, portion, basis } => validate_collect(entry, hold, *portion, basis, author, at, prev_action),
        LedgerKind::Waive { hold, portion } => validate_waive(hold, *portion, author, at, prev_action),
        LedgerKind::Forfeit { hold, basis } => validate_forfeit(hold, basis, author, at, prev_action),
        LedgerKind::Stake { catalog } => validate_stake(entry, catalog, author),
        LedgerKind::Unstake { stake, delisting } => validate_unstake(entry, stake, delisting, author, prev_action),
        LedgerKind::Redeem { issuer, instructions } => validate_redeem(entry, issuer, instructions.as_ref(), author),
        LedgerKind::Reclaim { redemption, outcome } => validate_reclaim(entry, redemption, outcome, author, prev_action),
    }?;
    if !matches!(kind_result, ValidateCallbackResult::Valid) {
        return Ok(kind_result);
    }

    // The orders in hand, and the limit on them.
    match in_hand_after(prior_in_hand, &entry.kind, author)? {
        Ok(in_hand) if in_hand == entry.in_hand => valid(),
        Ok(_) => invalid("a ledger entry's orders in hand must follow from the author's previous one"),
        Err(reason) => invalid(reason),
    }
}

/// The orders `author` has in hand after `kind`, from `prior` -- or why
/// `kind` would break the limit on them.
fn in_hand_after(prior: InHand, kind: &LedgerKind, author: &AgentPubKey) -> ExternResult<Result<InHand, &'static str>> {
    Ok(match kind {
        // Picking an order up: its driver's collateral.
        LedgerKind::Hold { order, purpose: purpose @ HoldPurpose::Collateral { .. } } => match hold_context(order, purpose)? {
            Ok((terms, _)) => prior.taking(terms.priority, relay_governance::max_concurrent_deliveries()).map_err(CarryRefusal::rule),
            Err(reason) => Err(reason),
        },
        // Settling one: the driver's collateral back, or forfeited.
        LedgerKind::Collect { hold, portion: Portion::Collateral, .. } | LedgerKind::Forfeit { hold, .. } => match hold_of(hold)? {
            Ok(hold) if &hold.payer == author => prior.settling().ok_or("no order is in hand to settle"),
            Ok(_) => Ok(prior),
            Err(reason) => Err(reason),
        },
        _ => Ok(prior),
    })
}

fn validate_deposit(entry: &LedgerEntry, grant_ref: &ActionHash, author: &AgentPubKey, at: Timestamp, prev_action: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let record = must_get_valid_record(grant_ref.clone())?;
    let Some(grant) = decode::<IssuerGrant>(&record) else { return invalid("a deposit must collect an issuer's grant") };
    if &grant.to != author || grant.amount != entry.amount {
        return invalid("a deposit must collect exactly a grant made to its author");
    }
    let granted_at = record.action().timestamp();
    if at < granted_at {
        return invalid("a grant is collected after it's made");
    }
    let again = ledger_since(author, prev_action, granted_at)?.into_iter().any(|e| matches!(&e.entry.kind, LedgerKind::Deposit { grant } if grant == grant_ref));
    if again {
        return invalid("that grant has already been collected");
    }
    valid()
}

/// An order's terms (from its as-created record) and, for a purpose that
/// names one, the bid -- which must be on this order.
fn hold_context(order: &ActionHash, purpose: &HoldPurpose) -> ExternResult<Result<(OrderTerms, Option<Bid>), &'static str>> {
    if &original_creation(order.clone())? != order {
        return Ok(Err("a hold must name the order's original action"));
    }
    let record = must_get_valid_record(order.clone())?;
    let terms = if let Some(order) = decode::<DeliveryOrder>(&record) {
        OrderTerms::of_delivery(&order)
    } else if let Some(order) = decode::<PickupOrder>(&record) {
        OrderTerms::of_pickup(&order)
    } else {
        return Ok(Err("a hold must be for an order"));
    };
    let bid_ref = match purpose {
        HoldPurpose::Food => None,
        HoldPurpose::DriverPay { bid } | HoldPurpose::Subsidy { bid } | HoldPurpose::Collateral { bid } => Some(bid),
    };
    let bid = match bid_ref {
        Some(bid_ref) => {
            let Some(bid) = decode::<Bid>(&must_get_valid_record(bid_ref.clone())?) else { return Ok(Err("a hold's bid must be a bid")) };
            if &original_creation(bid.order_ref.clone())? != order {
                return Ok(Err("a hold's bid must be on its order"));
            }
            Some(bid)
        }
        None => None,
    };
    Ok(Ok((terms, bid)))
}

fn validate_hold(entry: &LedgerEntry, order: &ActionHash, purpose: &HoldPurpose, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let (terms, bid) = match hold_context(order, purpose)? {
        Ok(context) => context,
        Err(reason) => return invalid(reason),
    };
    let Some((payer, shares)) = hold_terms(&terms, purpose, bid.as_ref()) else {
        return invalid("that kind of hold doesn't fit this order");
    };
    if &payer != author {
        return invalid("a hold is paid by whoever owes it");
    }
    if shares.is_empty() || entry.amount != hold_amount(&shares) {
        return invalid("a hold must set aside exactly what its order's terms owe");
    }
    valid()
}

/// A hold, as a collection or waiver needs it: who paid it, its parts, and
/// when it was made.
struct HoldContext {
    order: ActionHash,
    terms: OrderTerms,
    purpose: HoldPurpose,
    payer: AgentPubKey,
    shares: Vec<Share>,
    held_at: Timestamp,
}

fn hold_of(hold_ref: &ActionHash) -> ExternResult<Result<HoldContext, &'static str>> {
    let record = must_get_valid_record(hold_ref.clone())?;
    let Some(LedgerEntry { kind: LedgerKind::Hold { order, purpose }, .. }) = decode::<LedgerEntry>(&record) else {
        return Ok(Err("that isn't a hold"));
    };
    let (terms, bid) = match hold_context(&order, &purpose)? {
        Ok(context) => context,
        Err(reason) => return Ok(Err(reason)),
    };
    let Some((payer, shares)) = hold_terms(&terms, &purpose, bid.as_ref()) else { return Ok(Err("that hold doesn't fit its order")) };
    Ok(Ok(HoldContext { order, terms, purpose, payer, shares, held_at: record.action().timestamp() }))
}

/// Whether `author` has already collected or waived this part of the hold
/// -- every such entry is on their own chain, after the hold was made.
fn already_decided(author: &AgentPubKey, prev_action: &ActionHash, hold_ref: &ActionHash, portion: Portion, held_at: Timestamp) -> ExternResult<bool> {
    Ok(ledger_since(author, prev_action, held_at)?.into_iter().any(|e| match &e.entry.kind {
        LedgerKind::Collect { hold, portion: p, .. } | LedgerKind::Waive { hold, portion: p } => hold == hold_ref && *p == portion,
        LedgerKind::Forfeit { hold, .. } => hold == hold_ref && portion == Portion::Collateral,
        _ => false,
    }))
}

fn validate_waive(hold_ref: &ActionHash, portion: Portion, author: &AgentPubKey, at: Timestamp, prev_action: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let hold = match hold_of(hold_ref)? {
        Ok(hold) => hold,
        Err(reason) => return invalid(reason),
    };
    if !hold.shares.iter().any(|s| s.portion == portion && &s.recipient == author) {
        return invalid("only a part's recipient may waive it");
    }
    if at < hold.held_at {
        return invalid("a hold is decided after it's made");
    }
    if already_decided(author, prev_action, hold_ref, portion, hold.held_at)? {
        return invalid("that part of the hold has already been decided");
    }
    valid()
}

/// A driver conceding their collateral: theirs to concede (they paid it),
/// once, on the store's decision that the order never arrived.
fn validate_forfeit(hold_ref: &ActionHash, basis_ref: &ActionHash, author: &AgentPubKey, at: Timestamp, prev_action: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let hold = match hold_of(hold_ref)? {
        Ok(hold) => hold,
        Err(reason) => return invalid(reason),
    };
    if !matches!(hold.purpose, HoldPurpose::Collateral { .. }) || &hold.payer != author {
        return invalid("only a driver forfeits, and only their own collateral");
    }
    if at < hold.held_at {
        return invalid("a hold is decided after it's made");
    }
    if already_decided(author, prev_action, hold_ref, Portion::Collateral, hold.held_at)? {
        return invalid("that part of the hold has already been decided");
    }
    let ours = |bid: &Option<ActionHash>| bid.as_ref() == bid_of(&hold.purpose);
    match basis_of(basis_ref, &hold)? {
        Ok(Basis::NotDelivered { bid }) if ours(&bid) => valid(),
        Ok(Basis::Cancelled(Cancelled { by: Cancellation::NoDriver, liable, .. })) if ours(&liable) => valid(),
        Ok(_) => invalid("collateral is forfeited only when the store decides the order never arrived, or ends it for want of the driver who left it"),
        Err(reason) => invalid(reason),
    }
}

/// A store's listing stake: its owner's, for the network's amount, naming
/// the store by its original action.
fn validate_stake(entry: &LedgerEntry, catalog: &ActionHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let record = must_get_valid_record(catalog.clone())?;
    let Some(store) = decode::<MerchantCatalog>(&record) else { return invalid("a stake backs a store") };
    if !matches!(record.action().data, ActionData::Create(_)) || &store.owner != author {
        return invalid("a stake backs its author's own store, named by its original action");
    }
    require(entry.amount == relay_governance::store_listing_stake(), "a listing stake is the network's amount")
}

/// A listing stake taken back: the author's own, once, for what it set
/// aside, citing their deletion of the very listing it backed -- so a stake
/// never comes back while its listing stands.
fn validate_unstake(entry: &LedgerEntry, stake_ref: &ActionHash, delisting: &ActionHash, author: &AgentPubKey, prev_action: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let stake_record = must_get_valid_record(stake_ref.clone())?;
    let Some(LedgerEntry { kind: LedgerKind::Stake { catalog }, amount, .. }) = decode::<LedgerEntry>(&stake_record) else {
        return invalid("an unstake takes back a stake");
    };
    if stake_record.action().author() != author || entry.amount != amount {
        return invalid("an unstake takes back exactly its author's own stake");
    }
    if !deletes_listing(delisting, stake_ref, &catalog, author)? {
        return invalid("a stake comes back only once its listing is deleted, cited by that deletion");
    }
    let staked_at = stake_record.action().timestamp();
    let again = ledger_since(author, prev_action, staked_at)?.iter().any(|e| matches!(&e.entry.kind, LedgerKind::Unstake { stake, .. } if stake == stake_ref));
    require(!again, "a stake comes back once")
}

/// Whether `delisting` is `author`'s deletion of the listing `stake` backed:
/// a catalog link to `catalog` whose tag names the stake (a tag only a
/// listing may carry -- see `catalog_types::LISTING_TAG_PREFIX`).
fn deletes_listing(delisting: &ActionHash, stake: &ActionHash, catalog: &ActionHash, author: &AgentPubKey) -> ExternResult<bool> {
    let delete = must_get_action(delisting.clone())?;
    let ActionData::DeleteLink(delete_link) = &delete.hashed.content.data else { return Ok(false) };
    if delete.hashed.content.header.author != *author {
        return Ok(false);
    }
    let created = must_get_action(delete_link.link_add_address.clone())?;
    let ActionData::CreateLink(link) = &created.hashed.content.data else { return Ok(false) };
    let catalog_zome = dna_info()?.zome_names.iter().position(|name| name.0 == CATALOG_INTEGRITY_ZOME);
    Ok(catalog_zome.is_some_and(|index| usize::from(link.zome_index.0) == index)
        && link.tag.0 == listing_tag(stake)
        && link.target_address == AnyLinkableHash::from(catalog.clone()))
}

/// What entitles a collection.
enum Basis {
    /// The store's decision that the order reached its customer, with the
    /// bid that delivered it.
    Delivered { bid: Option<ActionHash> },
    /// The store's decision that it never did, with the bid that had it.
    NotDelivered { bid: Option<ActionHash> },
    /// The store's settlement of the food, with the refund it names.
    Settled { refund: u64 },
    /// The order cancelled.
    Cancelled(Cancelled),
    /// A part waived back to its payer.
    Waived { by: AgentPubKey, hold: ActionHash, portion: Portion },
    /// The driver behind `bid` leaving before pickup -- by their own choice
    /// or the store's -- whether they were calling the store late
    /// (`lineage::is_store_late_release`), when they leave paid in full, and
    /// whether they left from the counter, checked in: then the store's own
    /// chain says they came for the food, and they never answer for it.
    Released { bid: ActionHash, store_late: bool, at_store: bool },
    /// After the driver behind `bid` left, the store confirming another
    /// driver or recording the customer collecting it: someone else is
    /// getting the food to them, so the first no longer answers for it.
    Replaced { bid: ActionHash },
}

/// An order's cancellation, as the parts of its holds turn on it.
struct Cancelled {
    by: Cancellation,
    /// How far the order had got.
    from: Stage,
    /// Whether the store had started cooking it.
    cooking: bool,
    /// The driver's bid the order had, if any.
    bid: Option<ActionHash>,
    /// For `NoDriver`: the bid of the driver who answers for the food.
    liable: Option<ActionHash>,
}

/// How far an order had got when it was cancelled.
#[derive(PartialEq, Eq)]
enum Stage {
    /// Not yet accepted by the store.
    Waiting,
    /// Accepted; no driver yet (or a pickup order being prepared).
    Accepted,
    /// A driver assigned, not yet at the store.
    DriverAssigned,
    /// The driver checked in at the store.
    AtStore,
    Other,
}

fn delivery_stage(status: &DeliveryStatus) -> Stage {
    match status {
        DeliveryStatus::Scheduled | DeliveryStatus::Placed => Stage::Waiting,
        // Collecting: no driver, the customer coming for it.
        DeliveryStatus::Open | DeliveryStatus::Collecting => Stage::Accepted,
        DeliveryStatus::BidAccepted | DeliveryStatus::DriverEnRouteToMerchant | DeliveryStatus::MerchantConfirmed => Stage::DriverAssigned,
        DeliveryStatus::DriverAtStore => Stage::AtStore,
        _ => Stage::Other,
    }
}

fn pickup_stage(status: &PickupStatus) -> Stage {
    match status {
        PickupStatus::Placed => Stage::Waiting,
        PickupStatus::MerchantConfirmed | PickupStatus::ReadyForPickup => Stage::Accepted,
        _ => Stage::Other,
    }
}

/// The bid a hold is for, if it's for a driver.
fn bid_of(purpose: &HoldPurpose) -> Option<&ActionHash> {
    match purpose {
        HoldPurpose::Food => None,
        HoldPurpose::DriverPay { bid } | HoldPurpose::Subsidy { bid } | HoldPurpose::Collateral { bid } => Some(bid),
    }
}

/// The bid behind the version of `order` at `version_ref`.
fn bid_at(order: &ActionHash, version_ref: &ActionHash) -> ExternResult<Option<ActionHash>> {
    if &original_creation(version_ref.clone())? != order {
        return Ok(None);
    }
    Ok(Version::at(version_ref)?.and_then(|v| v.order.accepted_bid))
}

/// What `basis` entitles, for a hold on `hold.order` -- or why it doesn't.
/// The store's decisions are validated as its own (`dispatch_integrity`):
/// one each per order, by its store.
fn basis_of(basis_ref: &ActionHash, hold: &HoldContext) -> ExternResult<Result<Basis, &'static str>> {
    let record = must_get_valid_record(basis_ref.clone())?;
    let author = record.action().author().clone();
    if let Some(LedgerEntry { kind: LedgerKind::Waive { hold: waived, portion }, .. }) = decode::<LedgerEntry>(&record) {
        return Ok(Ok(Basis::Waived { by: author, hold: waived, portion }));
    }
    if let Some(outcome) = decode::<OrderOutcome>(&record) {
        if outcome.order != hold.order {
            return Ok(Err("that outcome is another order's"));
        }
        return Ok(Ok(match outcome.outcome {
            Outcome::Delivered { proof } => Basis::Delivered { bid: bid_at(&hold.order, &proof)? },
            Outcome::NotDelivered { claim } => Basis::NotDelivered { bid: bid_at(&hold.order, &claim)? },
        }));
    }
    if let Some(settlement) = decode::<ItemSettlement>(&record) {
        return Ok(if settlement.order == hold.order { Ok(Basis::Settled { refund: settlement.refund }) } else { Err("that settlement is another order's") });
    }
    if original_creation(basis_ref.clone())? != hold.order {
        return Ok(Err("a collection's basis must be about the hold's own order"));
    }
    if !hold.terms.delivery {
        let Some(order) = decode::<PickupOrder>(&record) else { return Ok(Err("that isn't a basis for collecting")) };
        let from = prior_version::<PickupOrder>(&record)?.map(|p| pickup_stage(&p.status));
        return Ok(match (order.cancellation, from) {
            (Some(by), Some(from)) => {
                let cooking = from == Stage::Accepted;
                Ok(Basis::Cancelled(Cancelled { by, from, cooking, bid: None, liable: None }))
            }
            _ => Err("that version of the order doesn't entitle anyone to collect"),
        });
    }
    let Some(version) = Version::of(record) else { return Ok(Err("that isn't a basis for collecting")) };
    let Some(prior) = version.prior()? else { return Ok(Err("that version of the order doesn't entitle anyone to collect")) };
    // A driver leaving -- this hold's.
    let released = version.released(&prior).filter(|_| matches!(version.order.status, DeliveryStatus::Open | DeliveryStatus::Collecting));
    if let Some(bid) = released.clone().filter(|bid| Some(bid) == bid_of(&hold.purpose)) {
        // The store moving them on by recording the customer collecting it:
        // the food reaches the customer another way, so the driver no longer
        // answers for it.
        let collecting = version.order.status == DeliveryStatus::Collecting && version.author() == &hold.terms.merchant;
        if collecting && matches!(hold.purpose, HoldPurpose::Collateral { .. }) {
            return Ok(Ok(Basis::Replaced { bid }));
        }
        let at_store = prior.order.status == DeliveryStatus::DriverAtStore;
        return Ok(Ok(Basis::Released { bid, store_late: lineage::is_store_late_release(&version, &prior)?, at_store }));
    }
    // The store confirming a later driver than the one this hold is for, or
    // recording the customer collecting it.
    if let Some(bid) = bid_of(&hold.purpose) {
        let collecting = version.order.status == DeliveryStatus::Collecting && prior.order.status != DeliveryStatus::Collecting;
        let replacing = lineage::confirms_driver(&version, &prior) || collecting;
        if replacing && version.order.accepted_bid.as_ref() != Some(bid) && version.author() == &hold.terms.merchant {
            let left_earlier = lineage::find_back(version.clone(), |v, p| p.and_then(|p| v.released(p)).filter(|b| b == bid))?.is_some();
            // (The store's own chain shows it never ended the order on that
            // driver's account: `dispatch_integrity`'s no-driver rule.)
            if left_earlier {
                return Ok(Ok(Basis::Replaced { bid: bid.clone() }));
            }
        }
    }
    // The order cancelled.
    let Some(by) = version.order.cancellation.clone() else { return Ok(Err("that version of the order doesn't entitle anyone to collect")) };
    if prior.order.status == DeliveryStatus::Cancelled {
        return Ok(Err("that version of the order doesn't entitle anyone to collect"));
    }
    let liable = if by == Cancellation::NoDriver { lineage::liable_release(&prior)?.map(|(_, bid)| bid) } else { None };
    Ok(Ok(Basis::Cancelled(Cancelled { by, from: delivery_stage(&prior.order.status), cooking: prior.order.ready_by.is_some(), bid: prior.order.accepted_bid.clone(), liable })))
}

/// The version an update replaced, as `T`.
fn prior_version<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(record: &Record) -> ExternResult<Option<T>> {
    let ActionData::Update(update) = &record.action().data else { return Ok(None) };
    Ok(decode::<T>(&must_get_valid_record(update.original_action_address.clone())?))
}

/// Whether a customer's own updates and requests on `order` bind them to
/// paying for it: they cancelled it, or asked to collect it -- on any
/// branch of its history -- so a refund that rests on another party's
/// update can't also be theirs.
fn customer_bound(customer: &AgentPubKey, chain_top: &ActionHash, order: &ActionHash, by_collecting: bool) -> ExternResult<bool> {
    let cancelled = lineage::wrote(customer, chain_top, order, |v, p| v.order.cancellation == Some(Cancellation::ByCustomer) && p.order.status != DeliveryStatus::Cancelled)?;
    Ok(cancelled || (by_collecting && lineage::asked_to_collect(customer, chain_top, order)?))
}

fn validate_collect(entry: &LedgerEntry, hold_ref: &ActionHash, portion: Portion, basis_ref: &ActionHash, author: &AgentPubKey, at: Timestamp, prev_action: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let hold = match hold_of(hold_ref)? {
        Ok(hold) => hold,
        Err(reason) => return invalid(reason),
    };
    let Some(share) = hold.shares.iter().find(|s| s.portion == portion).cloned() else {
        return invalid("that hold has no such part");
    };
    if at < hold.held_at {
        return invalid("a hold is decided after it's made");
    }
    if already_decided(author, prev_action, hold_ref, portion, hold.held_at)? {
        return invalid("that part of the hold has already been decided");
    }
    let basis = match basis_of(basis_ref, &hold)? {
        Ok(basis) => basis,
        Err(reason) => return invalid(reason),
    };
    let is_recipient = author == &share.recipient;
    let is_payer = author == &hold.payer;
    // What this collection takes: the whole part -- except the food at its
    // settlement, split between the store (the food less the refund) and
    // the customer (the refund).
    let expected = match (&portion, &basis) {
        (Portion::Food, Basis::Settled { refund }) if is_recipient => share.amount.checked_sub(*refund),
        (Portion::Food, Basis::Settled { refund }) if is_payer => Some(*refund),
        _ => Some(share.amount),
    };
    if expected.is_none_or(|amount| amount == 0 || amount != entry.amount) {
        return invalid("a collection takes exactly its part of the hold");
    }
    let hold_bid = bid_of(&hold.purpose);
    let ours = |bid: &Option<ActionHash>| hold_bid.is_some() && bid.as_ref() == hold_bid;
    let driver_pay = matches!(hold.purpose, HoldPurpose::DriverPay { .. });
    let store_fee = matches!(hold.purpose, HoldPurpose::Subsidy { .. });
    // A customer's refund resting on someone else's update -- a driver
    // leaving, calling the store late, the store ending it for want of a
    // driver -- can't also be theirs if they cancelled it themselves (owing
    // its driver) or chose to collect it (owing the food) on another branch.
    let customer_refund = |by_collecting: bool| -> ExternResult<bool> { Ok(is_payer && author == &hold.terms.requester && !customer_bound(author, prev_action, &hold.order, by_collecting)?) };
    let entitled = match (portion, basis) {
        // The food: split at its settlement; the customer's again if it never
        // arrived.
        (Portion::Food, Basis::Settled { .. }) => is_recipient || is_payer,
        (_, Basis::Settled { .. }) => false,
        (Portion::Food, Basis::Delivered { .. }) => false,
        (Portion::Food, Basis::NotDelivered { .. }) => is_payer,
        // The driver who delivered it is paid; their collateral, and what
        // the store set aside in case it kept them waiting, come back.
        (Portion::Collateral | Portion::LateCover, Basis::Delivered { bid }) => is_payer && ours(&bid),
        (Portion::Fee | Portion::Tip, Basis::Delivered { bid }) => is_recipient && ours(&bid),
        // Not delivered: the store takes the collateral for the food; the
        // driver's pay goes back.
        (Portion::Collateral, Basis::NotDelivered { bid }) => is_recipient && ours(&bid),
        (_, Basis::NotDelivered { bid }) => is_payer && ours(&bid),
        // A driver leaving before pickup: what the customer and the store set
        // aside for them goes back. Their collateral comes back once another
        // driver is confirmed -- or the store waives it, if they don't answer
        // for the food.
        // A driver who called the store late leaves paid in full by it, with
        // their collateral: they came for the food.
        (Portion::Fee | Portion::LateCover, Basis::Released { bid, store_late: true, .. }) if store_fee => is_recipient && hold_bid == Some(&bid),
        // A driver who left from the counter, checked in, has their
        // collateral back on leaving: the store's chain says they came, so
        // nothing can charge them for the food.
        (Portion::Collateral, Basis::Released { bid, at_store: true, .. }) => is_payer && hold_bid == Some(&bid),
        (Portion::Fee | Portion::Tip | Portion::LateCover, Basis::Released { bid, .. }) => is_payer && hold_bid == Some(&bid) && (!driver_pay || customer_refund(false)?),
        (Portion::Collateral, Basis::Replaced { bid }) => is_payer && hold_bid == Some(&bid),
        (_, Basis::Released { .. } | Basis::Replaced { .. }) => false,
        (portion, Basis::Cancelled(c)) => match c.by {
            // A customer who cancels once the store is cooking owes the food;
            // once a driver is assigned, their fee too.
            Cancellation::ByCustomer => match portion {
                Portion::Food => is_recipient && c.cooking && c.from != Stage::Waiting && c.from != Stage::Other,
                Portion::Fee => is_recipient && driver_pay && matches!(c.from, Stage::DriverAssigned | Stage::AtStore) && ours(&c.bid),
                _ => false,
            },
            // A store calling it off with the driver at its counter pays them
            // as if it had kept them waiting; and every driver's collateral is
            // theirs again -- the store ended it, on its own chain.
            Cancellation::ByStore(_) => match portion {
                Portion::Collateral => is_payer,
                _ => is_recipient && store_fee && c.from == Stage::AtStore && ours(&c.bid),
            },
            // A customer who chose to collect it and never came still owes
            // the food the store made.
            Cancellation::NotCollected => portion == Portion::Food && is_recipient,
            // The customer cancelling because the store kept a driver
            // waiting: they're refunded in full; a driver the store has
            // checked in is paid by the store, and every driver's collateral
            // is theirs again.
            Cancellation::StoreLate => match portion {
                Portion::Food => customer_refund(true)?,
                Portion::Fee | Portion::Tip if driver_pay => ours(&c.bid) && customer_refund(false)?,
                Portion::Fee | Portion::LateCover => is_recipient && store_fee && ours(&c.bid),
                Portion::Collateral => is_payer && ours(&c.bid),
                _ => false,
            },
            // No driver came: the customer is refunded, and the driver who
            // left it cooking pays the store for the food.
            Cancellation::NoDriver => match portion {
                Portion::Food => customer_refund(true)?,
                Portion::Collateral => is_recipient && c.liable.as_ref() == hold_bid,
                _ => false,
            },
            Cancellation::StoreDidNotRespond => false,
        },
        // A part its recipient gave back.
        (_, Basis::Waived { by, hold: waived, portion: p }) => is_payer && by == share.recipient && &waived == hold_ref && p == portion,
    };
    require(entitled, "that isn't grounds for its author to collect this part of the hold")
}

// --- cashing out ---

/// A cash-out: to an issuer on the roster other than its author, of at
/// least the network's minimum, with any payout instructions no larger than
/// a sealed note. (Its balance rule -- never below zero -- is checked with
/// the arithmetic.)
fn validate_redeem(entry: &LedgerEntry, issuer: &AgentPubKey, instructions: Option<&XSalsa20Poly1305EncryptedData>, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if !relay_governance::is_issuer(issuer)? {
        return invalid("a cash-out names an issuer on the network's roster");
    }
    if issuer == author {
        return invalid("an issuer pays out others, not itself");
    }
    let min = relay_governance::min_redemption_cents();
    if entry.amount < min {
        return invalid(&format!("a cash-out is at least {min}"));
    }
    if let Some(problem) = relay_integrity_support::amount_problem("amount", entry.amount) {
        return invalid(&problem);
    }
    if let Some(sealed) = instructions {
        if let Some(problem) = relay_integrity_support::sealed_problem("instructions", sealed, relay_integrity_support::limits::MAX_SEALED_BYTES) {
            return invalid(&problem);
        }
    }
    valid()
}

/// The `Redeem` entry at `redemption`, with its author and when it was made.
fn redemption_of(redemption: &ActionHash) -> ExternResult<Option<(AgentPubKey, AgentPubKey, u64, Timestamp)>> {
    let record = must_get_valid_record(redemption.clone())?;
    Ok(match decode::<LedgerEntry>(&record) {
        Some(LedgerEntry { kind: LedgerKind::Redeem { issuer, .. }, amount, .. }) => Some((record.action().author().clone(), issuer, amount, record.action().timestamp())),
        _ => None,
    })
}

/// An issuer's outcome for a cash-out: by the issuer it names, after it,
/// once -- so a cash-out is never both paid and returned -- with a
/// reference for a payout and a reason for a refusal.
fn validate_outcome(outcome: &RedemptionOutcome, author: &AgentPubKey, at: Timestamp, prev_action: Option<&ActionHash>) -> ExternResult<ValidateCallbackResult> {
    let Some((_, issuer, _, redeemed_at)) = redemption_of(&outcome.redemption)? else { return invalid("an outcome answers a cash-out") };
    if &issuer != author {
        return invalid("only the issuer a cash-out names decides it");
    }
    if at < redeemed_at {
        return invalid("an outcome comes after its cash-out");
    }
    let text = match &outcome.outcome {
        PayoutOutcome::Paid { reference } => text_problem("reference", reference, relay_integrity_support::limits::MAX_REFERENCE_CHARS).or_else(|| reference.trim().is_empty().then(|| "a payout names its reference".to_string())),
        PayoutOutcome::Declined { reason } => text_problem("reason", reason, relay_integrity_support::limits::MAX_NOTE_CHARS).or_else(|| reason.trim().is_empty().then(|| "a refusal says why".to_string())),
    };
    if let Some(problem) = text {
        return invalid(&problem);
    }
    let Some(prev) = prev_action else { return invalid("an outcome can't open a chain") };
    let again = relay_integrity_support::chain::wrote_since::<RedemptionOutcome>(author, prev, redeemed_at, UnitEntryTypes::RedemptionOutcome.try_into()?, |o| o.redemption == outcome.redemption)?;
    require(!again, "a cash-out is decided once")
}

/// A declined cash-out taken back: the author's own, for what it took,
/// citing its issuer's refusal, once.
fn validate_reclaim(entry: &LedgerEntry, redemption: &ActionHash, outcome_ref: &ActionHash, author: &AgentPubKey, prev_action: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let Some((redeemer, issuer, amount, redeemed_at)) = redemption_of(redemption)? else { return invalid("a reclaim takes back a cash-out") };
    if &redeemer != author || entry.amount != amount {
        return invalid("a reclaim takes back exactly its author's own cash-out");
    }
    let outcome_record = must_get_valid_record(outcome_ref.clone())?;
    let declined = outcome_record.action().author() == &issuer
        && decode::<RedemptionOutcome>(&outcome_record).is_some_and(|o| &o.redemption == redemption && matches!(o.outcome, PayoutOutcome::Declined { .. }));
    if !declined {
        return invalid("a cash-out comes back only on its issuer's refusal");
    }
    let again = ledger_since(author, prev_action, redeemed_at)?.iter().any(|e| matches!(&e.entry.kind, LedgerKind::Reclaim { redemption: r, .. } if r == redemption));
    require(!again, "a cash-out comes back once")
}

/// An issuer's profile: by an issuer on the roster, with sensible terms.
fn validate_issuer_profile(profile: &IssuerProfile, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    use relay_integrity_support::limits::{MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS, MAX_NOTE_CHARS};
    if !relay_governance::is_issuer(author)? {
        return invalid("only an issuer on the network's roster has an issuer profile");
    }
    if let Some(problem) = first_problem([
        text_problem("name", &profile.name, MAX_NAME_CHARS),
        text_problem("description", &profile.description, MAX_DESCRIPTION_CHARS),
        text_problem("contact", &profile.contact, MAX_NOTE_CHARS),
        relay_integrity_support::amount_problem("payout_fee_cents", profile.payout_fee_cents),
        relay_integrity_support::amount_problem("min_payout_cents", profile.min_payout_cents),
        text_problem("service_url", &profile.service_url, MAX_NOTE_CHARS),
    ]) {
        return Ok(problem);
    }
    if profile.name.trim().is_empty() {
        return invalid("an issuer has a name");
    }
    // The app calls it with people's keys and money: only over https.
    if !profile.service_url.is_empty() && !profile.service_url.starts_with("https://") && !profile.service_url.starts_with("http://localhost") && !profile.service_url.starts_with("http://127.0.0.1") {
        return invalid("an issuer's service is reached over https");
    }
    if profile.recovery_wait_days > 365 {
        return invalid("a recovery waits at most a year");
    }
    require(profile.payout_fee_basis_points <= 10_000, "a payout fee's share is at most the whole amount")
}
