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
//! - **Each part of a hold is decided once, by its recipient** -- collected
//!   with proof they're owed it (the customer's receipt, an arbitrator's
//!   ruling applied to the order, or a cancellation that entitles them), or
//!   waived back to the payer. Both are entries on the recipient's chain, so
//!   validation sees if they ever did both. The payer gets a part back only
//!   by that waiver or by a ruling, and never after they've given their
//!   receipt -- and a part collected on the strength of a receipt is refused
//!   if the payer had already been refunded it. Arbitrators never write
//!   money entries; their rulings are only ever evidence.
//!
//! What it can't: stop two contradictory rulings on one order (arbitrators
//! are the DNA's named trust anchor -- see `relay_governance`), or move
//! money nobody is entitled to collect yet (a customer who never confirms a
//! delivery leaves it held; an arbitrator's ruling releases it).

use attestation_types::{Leg, LegKind, ReceiptAttestation};
use dispatch_types::{hold_amount, hold_terms, Bid, Cancellation, DeliveryOrder, DeliveryStatus, IssueWindowClosed, IssueWindowOpened, OrderTerms, PickupOrder, PickupStatus, Share};
use dispute_types::{Dispute, DisputeOutcome, DisputeStatus};
use hdi::prelude::*;
pub use ledger_types::*;
use relay_integrity_support::{classify, decode, first_problem, invalid, link_target, original_creation, require, text_problem, valid, Checked, LinkTarget};

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
    match first_problem([text_problem("reference", &grant.reference, 100)]) {
        Some(problem) => Ok(problem),
        None => valid(),
    }
}

fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let LinkTarget::Record(record) = link_target(target)? else {
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
    let prior_balance = match &entry.previous {
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
            prior.balance
        }
        None => {
            if !ledger_entries(author, ChainFilter::new(prev_action.clone()))?.is_empty() {
                return invalid("previous must name the author's latest ledger entry");
            }
            0
        }
    };

    // The arithmetic, and the credit limit on what's spent.
    let amount = i128::from(entry.amount);
    let (expected, debit) = match &entry.kind {
        LedgerKind::Deposit { .. } | LedgerKind::Collect { .. } => (i128::from(prior_balance) + amount, false),
        LedgerKind::Hold { .. } => (i128::from(prior_balance) - amount, true),
        LedgerKind::Waive { .. } => {
            if entry.amount != 0 {
                return invalid("waiving changes nothing in the waiver's own balance");
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

    match &entry.kind {
        LedgerKind::Deposit { grant } => validate_deposit(entry, grant, author, at, prev_action),
        LedgerKind::Hold { order, purpose } => validate_hold(entry, order, purpose, author),
        LedgerKind::Collect { hold, portion, basis } => validate_collect(entry, hold, *portion, basis, author, at, prev_action),
        LedgerKind::Waive { hold, portion } => validate_waive(hold, *portion, author, at, prev_action),
    }
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

/// What entitles a collection.
enum Basis {
    /// The customer confirming they have the order.
    Receipt { by: AgentPubKey, at: ActionHash },
    /// An arbitrator's ruling, applied to the order; and how the order
    /// stands after it (a cancellation, if it was cancelled).
    Ruling { outcome: DisputeOutcome, cancellation: Option<Cancellation> },
    /// The order cancelled, from the status it had.
    Cancelled { by: Cancellation, from: Stage },
    /// A part waived back to its payer.
    Waived { by: AgentPubKey, hold: ActionHash, portion: Portion },
    /// The order's issue window closed by its arbitrator, with the refund
    /// owed for missing or wrong items.
    Closed { refund: u64 },
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
fn basis_of(basis_ref: &ActionHash, hold: &HoldContext) -> ExternResult<Result<Basis, &'static str>> {
    let record = must_get_valid_record(basis_ref.clone())?;
    let author = record.action().author().clone();
    if let Some(LedgerEntry { kind: LedgerKind::Waive { hold: waived, portion }, .. }) = decode::<LedgerEntry>(&record) {
        return Ok(Ok(Basis::Waived { by: author, hold: waived, portion }));
    }
    if let Some(closed) = decode::<IssueWindowClosed>(&record) {
        let Some(opened) = decode::<IssueWindowOpened>(&must_get_valid_record(closed.opened)?) else { return Ok(Err("a close must cite its window")) };
        return Ok(if opened.order == hold.order { Ok(Basis::Closed { refund: closed.refund }) } else { Err("that window is another order's") });
    }
    if let Some(receipt) = decode::<ReceiptAttestation>(&record) {
        let Some(leg) = decode::<Leg>(&must_get_valid_record(receipt.leg.clone())?) else { return Ok(Err("a receipt must acknowledge a handoff")) };
        let ours = leg.kind == LegKind::CustomerHandoff && original_creation(leg.order_ref)? == hold.order && author == hold.terms.requester;
        return Ok(if ours { Ok(Basis::Receipt { by: author, at: basis_ref.clone() }) } else { Err("that receipt isn't the customer's for this order") });
    }
    if original_creation(basis_ref.clone())? != hold.order {
        return Ok(Err("a collection's basis must be about the hold's own order"));
    }
    // The order itself, at a version that settles it.
    let (cancellation, dispute_ref, prior_stage) = if hold.terms.delivery {
        let Some(order) = decode::<DeliveryOrder>(&record) else { return Ok(Err("that isn't a basis for collecting")) };
        // Completed on the customer's scanned code: their receipt. (Such a
        // delivery can't then be disputed -- see dispatch validation.)
        if order.status == DeliveryStatus::Delivered && attestation_types::rests_on_scan(&order.delivery_receipts)? {
            return Ok(Ok(Basis::Receipt { by: author, at: basis_ref.clone() }));
        }
        let prior = prior_version::<DeliveryOrder>(&record)?.map(|p| delivery_stage(&p.status));
        (order.cancellation, order.dispute_ref, prior)
    } else {
        let Some(order) = decode::<PickupOrder>(&record) else { return Ok(Err("that isn't a basis for collecting")) };
        let prior = prior_version::<PickupOrder>(&record)?.map(|p| pickup_stage(&p.status));
        // The customer's own update collecting it is their receipt.
        if order.status == PickupStatus::PickedUp && author == hold.terms.requester {
            return Ok(Ok(Basis::Receipt { by: author, at: basis_ref.clone() }));
        }
        (order.cancellation, order.dispute_ref, prior)
    };
    if relay_governance::is_arbitrator(&author)? {
        let Some(dispute_ref) = dispute_ref else { return Ok(Err("an arbitrator's update settles an order only by a ruling")) };
        let Some(dispute) = decode::<Dispute>(&must_get_valid_record(dispute_ref)?) else { return Ok(Err("a ruling must be a dispute")) };
        let (DisputeStatus::Resolved, Some(outcome)) = (dispute.status, dispute.outcome) else { return Ok(Err("a ruling must be resolved")) };
        if dispute.order_ref != hold.order {
            return Ok(Err("a ruling must be about the hold's own order"));
        }
        return Ok(Ok(Basis::Ruling { outcome, cancellation }));
    }
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

/// Whether the hold's payer gave their receipt for its order between the
/// hold and `chain_top` -- the payer's own chain holds every receipt they
/// gave. A match by shape alone could only *refuse* a refund, never grant
/// one: a genuine receipt always matches, and is then checked for real.
fn payer_gave_receipt(hold: &HoldContext, chain_top: &ActionHash) -> ExternResult<bool> {
    let Some(filter) = activity_since(chain_top, hold.held_at)? else { return Ok(false) };
    for item in must_get_agent_activity(hold.payer.clone(), filter.include_cached_entries())? {
        let action = &item.action.hashed.content;
        let entry_hash = match &action.data {
            ActionData::Create(create) => create.entry_hash.clone(),
            ActionData::Update(update) => update.entry_hash.clone(),
            _ => continue,
        };
        let entry = match item.cached_entry {
            Some(entry) => entry,
            None => must_get_entry(entry_hash)?.content,
        };
        let Entry::App(bytes) = entry else { continue };
        let bytes = SerializedBytes::from(bytes);
        let receipt = if hold.terms.delivery {
            match ReceiptAttestation::try_from(bytes) {
                Ok(receipt) => match must_get_valid_record(receipt.leg).ok().and_then(|r| decode::<Leg>(&r)) {
                    Some(leg) => leg.kind == LegKind::CustomerHandoff && original_creation(leg.order_ref).ok().as_ref() == Some(&hold.order),
                    None => false,
                },
                Err(_) => false,
            }
        } else {
            PickupOrder::try_from(bytes).is_ok_and(|order| order.status == PickupStatus::PickedUp)
                && original_creation(item.action.hashed.hash.clone()).ok().as_ref() == Some(&hold.order)
        };
        if receipt {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether the hold's payer was refunded it between the hold and `chain_top`.
fn payer_was_refunded(hold: &HoldContext, hold_ref: &ActionHash, chain_top: &ActionHash) -> ExternResult<bool> {
    let Some(filter) = activity_since(chain_top, hold.held_at)? else { return Ok(false) };
    Ok(ledger_entries(&hold.payer, filter)?.into_iter().any(|e| matches!(&e.entry.kind, LedgerKind::Collect { hold, .. } if hold == hold_ref)))
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
    // What this collection takes: the whole part -- except the food at an
    // issue window's close, split between the store (the food less the
    // refund) and the customer (the refund).
    let expected = match (&portion, &basis) {
        (Portion::Food, Basis::Closed { refund }) if is_recipient => share.amount.checked_sub(*refund),
        (Portion::Food, Basis::Closed { refund }) if is_payer => Some(*refund),
        _ => Some(share.amount),
    };
    if expected.is_none_or(|amount| amount == 0 || amount != entry.amount) {
        return invalid("a collection takes exactly its part of the hold");
    }
    // On a network with arbitrators, the food's payment for a confirmed
    // order moves only when its issue window closes -- never on the receipt
    // or a ruling, which would skip the window.
    let windowed = relay_governance::closing_arbitrator(&hold.order).is_some();
    let entitled = match (portion, basis) {
        (Portion::Food, Basis::Closed { .. }) => windowed && (is_recipient || is_payer),
        (_, Basis::Closed { .. }) => false,
        (Portion::Food, Basis::Receipt { .. } | Basis::Ruling { outcome: DisputeOutcome::FavorProvider, .. }) if windowed => false,
        // The driver's collateral: theirs again once the food is delivered,
        // the store's if a ruling says it never was.
        (Portion::Collateral, Basis::Receipt { .. }) | (Portion::Collateral, Basis::Ruling { outcome: DisputeOutcome::FavorProvider, .. }) => is_payer,
        (Portion::Collateral, Basis::Ruling { outcome: DisputeOutcome::FavorRequester, .. }) => is_recipient,
        (Portion::Collateral, _) => false,
        // A part its payer owes, once the customer has the order -- unless
        // they'd already been refunded it.
        (_, Basis::Receipt { by, at: receipt }) => {
            if !is_recipient {
                false
            } else if by == hold.payer {
                !payer_was_refunded(&hold, hold_ref, &receipt)?
            } else {
                true
            }
        }
        (_, Basis::Ruling { outcome: DisputeOutcome::FavorProvider, .. }) => is_recipient,
        // A refund by ruling -- never for an order the customer cancelled
        // themselves, nor after they'd given their receipt.
        (_, Basis::Ruling { outcome: DisputeOutcome::FavorRequester, cancellation }) => is_payer && cancellation != Some(Cancellation::ByCustomer) && !payer_gave_receipt(&hold, prev_action)?,
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
