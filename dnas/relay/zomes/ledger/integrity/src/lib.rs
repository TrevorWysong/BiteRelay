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
//! What it can't: move money nobody is entitled to collect yet. An order
//! nobody has decided stays held.

use dispatch_types::{hold_amount, hold_terms, Bid, Cancellation, DeliveryOrder, DeliveryStatus, ItemSettlement, OrderOutcome, OrderTerms, Outcome, PickupOrder, PickupStatus, Share};
use hdi::prelude::*;
pub use ledger_types::*;
use relay_integrity_support::{classify, decode, first_problem, invalid, linked_record, original_creation, require, text_problem, valid, Checked};

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    LedgerEntry(LedgerEntry),
    IssuerGrant(IssuerGrant),
}

#[hdk_link_types]
pub enum LinkTypes {
    /// An order's holds, so its parties can find what they're owed.
    OrderToHold,
    /// A hold's waivers, so its payer can find what's returned to them.
    HoldToWaive,
    /// An agent's grants, so they can collect them.
    AgentToGrant,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match classify(op.flattened::<EntryTypes, LinkTypes>()?)? {
        Checked::Create { entry, action } => match entry {
            EntryTypes::LedgerEntry(entry) => validate_entry(&entry, action.author(), action.timestamp(), action.prev_action()),
            EntryTypes::IssuerGrant(grant) => validate_grant(&grant, action.author()),
        },
        Checked::Update { .. } => invalid("ledger entries can't be changed"),
        Checked::Delete { .. } => invalid("ledger entries can't be deleted"),
        Checked::CreateLink { link_type, action } => validate_create_link(link_type, &action.base_address, &action.target_address, action.author()),
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
    match first_problem([text_problem("reference", &grant.reference, relay_integrity_support::limits::MAX_REFERENCE_CHARS)]) {
        Some(problem) => Ok(problem),
        None => valid(),
    }
}

fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let Some(record) = linked_record(target)? else {
        return invalid("ledger links must target a record");
    };
    if author != record.action().author() {
        return invalid("a ledger link must be authored by the author of the entry it indexes");
    }
    let expected: Option<AnyLinkableHash> = match link_type {
        LinkTypes::OrderToHold => match decode::<LedgerEntry>(&record).map(|e| e.kind) {
            Some(LedgerKind::Hold { order, .. }) => Some(order.into()),
            _ => None,
        },
        LinkTypes::HoldToWaive => match decode::<LedgerEntry>(&record).map(|e| e.kind) {
            Some(LedgerKind::Waive { hold, .. }) => Some(hold.into()),
            _ => None,
        },
        LinkTypes::AgentToGrant => decode::<IssuerGrant>(&record).map(|grant| grant.to.into()),
    };
    match expected {
        Some(expected) => require(&expected == base, "a ledger link must sit under the order, hold or agent its entry is about"),
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

/// Every ledger entry on `agent`'s chain within `filter`, newest first.
fn ledger_entries(agent: &AgentPubKey, filter: ChainFilter) -> ExternResult<Vec<ChainEntry>> {
    let mut entries = Vec::new();
    for item in must_get_agent_activity(agent.clone(), filter.include_cached_entries())? {
        let action = &item.action.hashed.content;
        if !is_ledger_entry(action)? {
            continue;
        }
        let ActionData::Create(create) = &action.data else { continue };
        let entry = match item.cached_entry {
            Some(entry) => entry,
            None => must_get_entry(create.entry_hash.clone())?.content,
        };
        let Entry::App(bytes) = entry else { continue };
        let Ok(entry) = LedgerEntry::try_from(SerializedBytes::from(bytes)) else { continue };
        entries.push(ChainEntry { hash: item.action.hashed.hash.clone(), entry });
    }
    Ok(entries)
}

/// The walk of an agent's chain from `chain_top` (an action on it) back to the first action
/// at or after `since` -- empty if the chain hadn't reached `since` yet.
fn activity_since(chain_top: &ActionHash, since: Timestamp) -> ExternResult<Option<ChainFilter>> {
    let top = must_get_action(chain_top.clone())?;
    Ok((top.hashed.content.header.timestamp >= since).then(|| ChainFilter::until_timestamp(chain_top.clone(), since)))
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
            let between = ledger_entries(author, ChainFilter::until_hash(prev_action.clone(), previous.clone()))?;
            if between.iter().any(|e| &e.hash != previous) {
                return invalid("previous must be the author's latest ledger entry");
            }
            (prior.balance, prior.in_hand)
        }
        None => {
            if !ledger_entries(author, ChainFilter::new(prev_action.clone()))?.is_empty() {
                return invalid("previous must name the author's latest ledger entry");
            }
            (0, InHand::default())
        }
    };
    let (prior_balance, prior_in_hand) = prior;

    // The arithmetic, and the credit limit on what's spent.
    let amount = i128::from(entry.amount);
    let (expected, debit) = match &entry.kind {
        LedgerKind::Deposit { .. } | LedgerKind::Collect { .. } => (i128::from(prior_balance) + amount, false),
        LedgerKind::Hold { .. } => (i128::from(prior_balance) - amount, true),
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
    if let Some(filter) = activity_since(prev_action, granted_at)? {
        let again = ledger_entries(author, filter)?.into_iter().any(|e| matches!(&e.entry.kind, LedgerKind::Deposit { grant } if grant == grant_ref));
        if again {
            return invalid("that grant has already been collected");
        }
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
    let Some(filter) = activity_since(prev_action, held_at)? else { return Ok(false) };
    Ok(ledger_entries(author, filter)?.into_iter().any(|e| match &e.entry.kind {
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
    match basis_of(basis_ref, &hold)? {
        Ok(Basis::NotDelivered) => valid(),
        Ok(_) => invalid("collateral is forfeited only on the store's decision that the order never arrived"),
        Err(reason) => invalid(reason),
    }
}

/// What entitles a collection.
enum Basis {
    /// The store's decision that the order reached its customer.
    Delivered,
    /// The store's decision that it never did.
    NotDelivered,
    /// The store's settlement of the food, with the refund it names.
    Settled { refund: u64 },
    /// The order cancelled, from the status it had.
    Cancelled { by: Cancellation, from: Stage },
    /// A part waived back to its payer.
    Waived { by: AgentPubKey, hold: ActionHash, portion: Portion },
}

/// How far an order had got when it was cancelled.
#[derive(PartialEq, Eq)]
enum Stage {
    /// Not yet accepted by the store.
    Waiting,
    /// Accepted; no driver yet (or a pickup order being prepared).
    Accepted,
    /// A driver assigned, not yet picked up.
    DriverAssigned,
    Other,
}

fn delivery_stage(status: &DeliveryStatus) -> Stage {
    match status {
        DeliveryStatus::Scheduled | DeliveryStatus::Placed => Stage::Waiting,
        DeliveryStatus::Open => Stage::Accepted,
        DeliveryStatus::BidAccepted | DeliveryStatus::MerchantConfirmed | DeliveryStatus::DriverEnRouteToMerchant => Stage::DriverAssigned,
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
            Outcome::Delivered { .. } => Basis::Delivered,
            Outcome::NotDelivered { .. } => Basis::NotDelivered,
        }));
    }
    if let Some(settlement) = decode::<ItemSettlement>(&record) {
        return Ok(if settlement.order == hold.order { Ok(Basis::Settled { refund: settlement.refund }) } else { Err("that settlement is another order's") });
    }
    if original_creation(basis_ref.clone())? != hold.order {
        return Ok(Err("a collection's basis must be about the hold's own order"));
    }
    // The order itself, at the version that cancelled it.
    let (cancellation, prior_stage) = if hold.terms.delivery {
        let Some(order) = decode::<DeliveryOrder>(&record) else { return Ok(Err("that isn't a basis for collecting")) };
        (order.cancellation, prior_version::<DeliveryOrder>(&record)?.map(|p| delivery_stage(&p.status)))
    } else {
        let Some(order) = decode::<PickupOrder>(&record) else { return Ok(Err("that isn't a basis for collecting")) };
        (order.cancellation, prior_version::<PickupOrder>(&record)?.map(|p| pickup_stage(&p.status)))
    };
    match (cancellation, prior_stage) {
        (Some(by), Some(from)) => Ok(Ok(Basis::Cancelled { by, from })),
        _ => Ok(Err("that version of the order doesn't entitle anyone to collect")),
    }
}

/// The version an update replaced, as `T`.
fn prior_version<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(record: &Record) -> ExternResult<Option<T>> {
    let ActionData::Update(update) = &record.action().data else { return Ok(None) };
    Ok(decode::<T>(&must_get_valid_record(update.original_action_address.clone())?))
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
    let entitled = match (portion, basis) {
        // The food: split at its settlement; the customer's again if it never
        // arrived.
        (Portion::Food, Basis::Settled { .. }) => is_recipient || is_payer,
        (_, Basis::Settled { .. }) => false,
        (Portion::Food, Basis::Delivered) => false,
        // The driver's collateral: theirs again once the food is delivered,
        // the store's if it never was.
        (Portion::Collateral, Basis::Delivered) => is_payer,
        (Portion::Collateral, Basis::NotDelivered) => is_recipient,
        // The driver's pay and the store's subsidy: the driver's once it's
        // delivered, back to whoever paid if it never was.
        (_, Basis::Delivered) => is_recipient,
        (_, Basis::NotDelivered) => is_payer,
        // A customer who cancels after the store has accepted still owes the
        // food; after a driver is assigned, the driver's fee too.
        (Portion::Food, Basis::Cancelled { by: Cancellation::ByCustomer, from }) => is_recipient && from != Stage::Waiting && from != Stage::Other,
        (Portion::Fee, Basis::Cancelled { by: Cancellation::ByCustomer, from: Stage::DriverAssigned }) => is_recipient && matches!(hold.purpose, HoldPurpose::DriverPay { .. }),
        (_, Basis::Cancelled { .. }) => false,
        // A part its recipient gave back.
        (_, Basis::Waived { by, hold: waived, portion: p }) => is_payer && by == share.recipient && &waived == hold_ref && p == portion,
    };
    require(entitled, "that isn't grounds for its author to collect this part of the hold")
}
