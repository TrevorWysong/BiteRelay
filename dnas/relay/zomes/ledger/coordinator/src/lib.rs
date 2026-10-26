//! Coordinator zome for the ledger: placing holds for orders, collecting or
//! waiving the parts owed to the caller, issuing and collecting funds, and
//! reading balances. See the integrity crate for what validation
//! guarantees -- every function here only ever writes to the caller's own
//! chain, with the balance that follows from their last entry.

use dispatch_types::{hold_amount, hold_terms, Bid, DeliveryOrder, OrderTerms, PickupOrder, Share};
use hdk::prelude::*;
use ledger_integrity::*;
use relay_coordinator_support::original_action_of;

mod cash_out;
mod standing;
pub use cash_out::*;
pub use standing::*;

pub(crate) fn guest(message: impl Into<String>) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message.into()))
}

/// The caller's ledger entries, oldest first.
pub(crate) fn my_entries() -> ExternResult<Vec<Record>> {
    query(ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::LedgerEntry)?).include_entries(true))
}

pub(crate) fn entry_of(record: &Record) -> Option<LedgerEntry> {
    record.entry().to_app_option::<LedgerEntry>().ok().flatten()
}

/// Whether the caller closed their chain (moved to another network).
fn chain_closed() -> ExternResult<bool> {
    let closes = query(ChainQueryFilter::new().action_type(ActionType::CloseChain))?;
    Ok(!closes.is_empty())
}

/// Writes the caller's next ledger entry, after their latest.
pub(crate) fn append(kind: LedgerKind, amount: u64) -> ExternResult<ActionHash> {
    let latest = my_entries()?.into_iter().last();
    let (previous, balance, in_hand) = match &latest {
        Some(record) => {
            let prior = entry_of(record);
            (Some(record.action_address().clone()), prior.as_ref().map_or(0, |e| e.balance), prior.map(|e| e.in_hand).unwrap_or_default())
        }
        None => (None, 0, InHand::default()),
    };
    if chain_closed()? {
        return Err(guest("This account has moved to the new version of Relay."));
    }
    let in_hand = in_hand_after(in_hand, &kind)?;
    let signed = i64::try_from(amount).map_err(|_| guest("amount out of range"))?;
    let balance = match kind {
        LedgerKind::Hold { .. } | LedgerKind::Stake { .. } => {
            let after = balance - signed;
            let limit = relay_governance::credit_limit_cents() as i64;
            if after < -limit {
                return Err(guest("Not enough funds for this order."));
            }
            after
        }
        // Only money that's there leaves: never credit.
        LedgerKind::Redeem { .. } => {
            if balance < signed {
                return Err(guest("You can cash out up to your balance."));
            }
            balance - signed
        }
        LedgerKind::Waive { .. } | LedgerKind::Forfeit { .. } => balance,
        LedgerKind::Deposit { .. } | LedgerKind::Collect { .. } | LedgerKind::Unstake { .. } | LedgerKind::Reclaim { .. } => balance + signed,
    };
    create_entry(&EntryTypes::LedgerEntry(LedgerEntry { kind, amount, balance, in_hand, previous }))
}

/// The caller's orders in hand after `kind` -- `ledger_integrity`'s rule,
/// checked here first so a driver at their limit is told why.
fn in_hand_after(prior: InHand, kind: &LedgerKind) -> ExternResult<InHand> {
    match kind {
        LedgerKind::Hold { order, purpose: purpose @ HoldPurpose::Collateral { .. } } => {
            let (terms, _) = order_context(order, purpose)?;
            prior.taking(terms.priority, relay_governance::max_concurrent_deliveries()).map_err(|refusal| guest(pickup_refusal(refusal)))
        }
        // The caller's own collateral, back or forfeited (holds are written
        // by their payers).
        LedgerKind::Collect { hold, portion: Portion::Collateral, .. } | LedgerKind::Forfeit { hold, .. } => {
            let record = get(hold.clone(), GetOptions::default())?.ok_or(guest("hold not found"))?;
            if record.action().author() != &agent_info()?.agent_initial_pubkey {
                return Ok(prior);
            }
            prior.settling().ok_or(guest("no order is in hand to settle"))
        }
        _ => Ok(prior),
    }
}

/// Why a driver can't pick an order up, told to them.
fn pickup_refusal(refusal: CarryRefusal) -> String {
    match refusal {
        CarryRefusal::CarryingPriority => "You're delivering a priority order, which goes on its own. Deliver it before picking up another.".into(),
        CarryRefusal::PriorityGoesAlone => "This is a priority order: it's picked up with nothing else in hand. Deliver your other orders first.".into(),
        CarryRefusal::AtLimit => format!("You're carrying {} orders, the most at once. Deliver one first.", relay_governance::max_concurrent_deliveries()),
    }
}

// --- funds ---

#[derive(Serialize, Deserialize, Debug)]
pub struct IssueGrantInput {
    pub to: AgentPubKey,
    pub amount: u64,
    pub reference: String,
}

/// An issuer (see `relay_governance::is_issuer`) crediting an agent -- the
/// network's stand-in for a payment processor's top-up.
#[hdk_extern]
pub fn issue_grant(input: IssueGrantInput) -> ExternResult<ActionHash> {
    // Safe to repeat: a payment granted already isn't granted again -- an
    // issuer's service that lost its connection mid-call can't know whether
    // its grant went through, so it asks again.
    let mine = query(ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::IssuerGrant)?).include_entries(true))?;
    if let Some(existing) = mine.iter().find(|r| r.entry().to_app_option::<IssuerGrant>().ok().flatten().is_some_and(|g| g.reference == input.reference)) {
        return Ok(existing.action_address().clone());
    }
    let to = input.to.clone();
    let hash = create_entry(&EntryTypes::IssuerGrant(IssuerGrant { to: input.to, amount: input.amount, reference: input.reference }))?;
    create_link(to, hash.clone(), LinkTypes::AgentToGrant, ())?;
    Ok(hash)
}

/// Collects every grant made to the caller that they haven't yet; returns
/// how many.
#[hdk_extern]
pub fn collect_grants(_: ()) -> ExternResult<u32> {
    let me = agent_info()?.agent_initial_pubkey;
    let collected: Vec<ActionHash> = my_entries()?
        .iter()
        .filter_map(entry_of)
        .filter_map(|e| match e.kind {
            LedgerKind::Deposit { grant } => Some(grant),
            _ => None,
        })
        .collect();
    let mut count = 0;
    for link in get_links(LinkQuery::try_new(me.clone(), LinkTypes::AgentToGrant)?, GetStrategy::default())? {
        let Some(grant_ref) = link.target.into_action_hash() else { continue };
        if collected.contains(&grant_ref) {
            continue;
        }
        let Some(record) = get(grant_ref.clone(), GetOptions::default())? else { continue };
        let Ok(Some(grant)) = record.entry().to_app_option::<IssuerGrant>() else { continue };
        if grant.to != me {
            continue;
        }
        append(LedgerKind::Deposit { grant: grant_ref }, grant.amount)?;
        count += 1;
    }
    Ok(count)
}

// --- holds ---

/// One part of a hold, over the zome-call boundary.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ShareView {
    pub portion: Portion,
    pub recipient: AgentPubKey,
    pub amount: u64,
}

impl From<&Share> for ShareView {
    fn from(share: &Share) -> Self {
        Self { portion: share.portion, recipient: share.recipient.clone(), amount: share.amount }
    }
}

/// An order's terms, from its original record, and the bid a purpose names.
fn order_context(order: &ActionHash, purpose: &HoldPurpose) -> ExternResult<(OrderTerms, Option<Bid>)> {
    let record = get(order.clone(), GetOptions::default())?.ok_or(guest("order not found"))?;
    let terms = if let Ok(Some(order)) = record.entry().to_app_option::<DeliveryOrder>() {
        OrderTerms::of_delivery(&order)
    } else if let Ok(Some(order)) = record.entry().to_app_option::<PickupOrder>() {
        OrderTerms::of_pickup(&order)
    } else {
        return Err(guest("that isn't an order"));
    };
    let bid = match purpose {
        HoldPurpose::Food => None,
        HoldPurpose::DriverPay { bid } | HoldPurpose::Subsidy { bid } | HoldPurpose::Collateral { bid } => {
            let record = get(bid.clone(), GetOptions::default())?.ok_or(guest("bid not found"))?;
            record.entry().to_app_option::<Bid>().map_err(|e| wasm_error!(e))?
        }
    };
    Ok((terms, bid))
}

/// Who pays a hold for `purpose` on `order`, and its parts.
fn terms_of(order: &ActionHash, purpose: &HoldPurpose) -> ExternResult<(AgentPubKey, Vec<Share>)> {
    let (terms, bid) = order_context(order, purpose)?;
    hold_terms(&terms, purpose, bid.as_ref()).ok_or(guest("that kind of hold doesn't fit this order"))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PlaceHoldInput {
    /// The order (any version of it).
    pub order: ActionHash,
    pub purpose: HoldPurpose,
}

/// Sets aside what the caller owes for `purpose` on an order, priced from
/// its terms -- `None` if there's nothing to hold (a customer ordering from
/// their own store, a fee the store covers in full). Safe to repeat: a hold
/// already placed is returned. Called by the dispatch zome in the same call
/// as the order step that needs it, so the two commit together.
#[hdk_extern]
pub fn place_hold(input: PlaceHoldInput) -> ExternResult<Option<ActionHash>> {
    let order = original_action_of(input.order)?;
    let (payer, shares) = terms_of(&order, &input.purpose)?;
    if payer != agent_info()?.agent_initial_pubkey {
        return Err(guest("a hold is placed by whoever owes it"));
    }
    if shares.is_empty() {
        return Ok(None);
    }
    let existing = my_entries()?.into_iter().find(|record| {
        entry_of(record).is_some_and(|e| matches!(&e.kind, LedgerKind::Hold { order: o, purpose: p } if o == &order && p == &input.purpose))
    });
    if let Some(record) = existing {
        return Ok(Some(record.action_address().clone()));
    }
    let hash = append(LedgerKind::Hold { order: order.clone(), purpose: input.purpose }, hold_amount(&shares))?;
    create_link(order, hash.clone(), LinkTypes::OrderToHold, ())?;
    Ok(Some(hash))
}

/// A hold on an order: who paid it, what for, and its parts.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HoldView {
    pub hold: ActionHash,
    pub payer: AgentPubKey,
    pub purpose: HoldPurpose,
    pub amount: u64,
    pub held_at: Timestamp,
    pub shares: Vec<ShareView>,
}

/// Every hold on an order (its original action, or any version).
#[hdk_extern]
pub fn holds_for_order(order: ActionHash) -> ExternResult<Vec<HoldView>> {
    let order = original_action_of(order)?;
    let mut holds = Vec::new();
    for link in get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToHold)?, GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash.clone(), GetOptions::default())? else { continue };
        let Some(LedgerEntry { kind: LedgerKind::Hold { order: held_for, purpose }, amount, .. }) = entry_of(&record) else { continue };
        if held_for != order {
            continue;
        }
        let Ok((payer, shares)) = terms_of(&order, &purpose) else { continue };
        if &payer != record.action().author() {
            continue;
        }
        holds.push(HoldView { hold: hash, payer, purpose, amount, held_at: record.action().timestamp(), shares: shares.iter().map(ShareView::from).collect() });
    }
    Ok(holds)
}

// --- deciding a part of a hold ---

/// Whether the caller has already collected, waived or forfeited this part.
fn my_decision(hold: &ActionHash, portion: Portion) -> ExternResult<Option<ActionHash>> {
    Ok(my_entries()?.into_iter().find_map(|record| {
        let decided = entry_of(&record).is_some_and(|e| match &e.kind {
            LedgerKind::Collect { hold: h, portion: p, .. } | LedgerKind::Waive { hold: h, portion: p } => h == hold && *p == portion,
            LedgerKind::Forfeit { hold: h, .. } => h == hold && portion == Portion::Collateral,
            _ => false,
        });
        decided.then(|| record.action_address().clone())
    }))
}

/// A hold's part, as recorded on its order.
fn share_of(hold: &ActionHash, portion: Portion) -> ExternResult<(HoldView, ShareView)> {
    let record = get(hold.clone(), GetOptions::default())?.ok_or(guest("hold not found"))?;
    let Some(LedgerEntry { kind: LedgerKind::Hold { order, .. }, .. }) = entry_of(&record) else { return Err(guest("that isn't a hold")) };
    let view = holds_for_order(order)?.into_iter().find(|h| &h.hold == hold).ok_or(guest("hold not found on its order"))?;
    let share = view.shares.iter().find(|s| s.portion == portion).cloned().ok_or(guest("that hold has no such part"))?;
    Ok((view, share))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CollectInput {
    pub hold: ActionHash,
    pub portion: Portion,
    /// What entitles the caller -- see `ledger_integrity::Basis`.
    pub basis: ActionHash,
}

/// Collects a part of a hold the caller is entitled to. Safe to repeat.
#[hdk_extern]
pub fn collect(input: CollectInput) -> ExternResult<ActionHash> {
    if let Some(done) = my_decision(&input.hold, input.portion)? {
        return Ok(done);
    }
    let (hold, share) = share_of(&input.hold, input.portion)?;
    let amount = match settled_refund(&input.basis)? {
        // The store's settlement splits the food: the store the rest, the
        // customer the refund.
        Some(refund) if input.portion == Portion::Food => {
            if agent_info()?.agent_initial_pubkey == hold.payer {
                refund
            } else {
                share.amount.saturating_sub(refund)
            }
        }
        _ => share.amount,
    };
    if amount == 0 {
        return Err(guest("there's nothing to collect"));
    }
    append(LedgerKind::Collect { hold: input.hold, portion: input.portion, basis: input.basis }, amount)
}

/// The refund the store's settlement names, if `basis` is one.
fn settled_refund(basis: &ActionHash) -> ExternResult<Option<u64>> {
    let Some(record) = get(basis.clone(), GetOptions::default())? else { return Ok(None) };
    Ok(record.entry().to_app_option::<dispatch_types::ItemSettlement>().ok().flatten().map(|c| c.refund))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct WaiveInput {
    pub hold: ActionHash,
    pub portion: Portion,
}

/// The caller, a part's recipient, giving it back to the hold's payer.
/// Safe to repeat.
#[hdk_extern]
pub fn waive(input: WaiveInput) -> ExternResult<ActionHash> {
    if let Some(done) = my_decision(&input.hold, input.portion)? {
        return Ok(done);
    }
    let hash = append(LedgerKind::Waive { hold: input.hold.clone(), portion: input.portion }, 0)?;
    create_link(input.hold, hash.clone(), LinkTypes::HoldToWaive, ())?;
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ForfeitInput {
    pub hold: ActionHash,
    /// The store's decision that the order never arrived.
    pub basis: ActionHash,
}

/// The caller, a driver, conceding their collateral on the store's decision
/// that the order never arrived -- which settles it as an order in hand.
/// Safe to repeat.
#[hdk_extern]
pub fn forfeit(input: ForfeitInput) -> ExternResult<ActionHash> {
    if let Some(done) = my_decision(&input.hold, Portion::Collateral)? {
        return Ok(done);
    }
    append(LedgerKind::Forfeit { hold: input.hold, basis: input.basis }, 0)
}

/// Sets aside the caller's stake for listing their store (`catalog`, its
/// original action) -- the network's amount, returned when the listing
/// comes down (`unstake_listing`). Called by the catalog zome as it lists the
/// store, so the two commit together.
#[hdk_extern]
pub fn stake_listing(catalog: ActionHash) -> ExternResult<ActionHash> {
    append(LedgerKind::Stake { catalog }, relay_governance::store_listing_stake())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UnstakeInput {
    pub stake: ActionHash,
    /// The caller's deletion of the listing the stake backed.
    pub delisting: ActionHash,
}

/// Takes a listing stake back, citing the listing's deletion. Called by
/// the catalog zome as it takes the listing down, so the two commit
/// together.
#[hdk_extern]
pub fn unstake_listing(input: UnstakeInput) -> ExternResult<ActionHash> {
    let record = get(input.stake.clone(), GetOptions::local())?.ok_or(guest("stake not found"))?;
    let Some(LedgerEntry { kind: LedgerKind::Stake { .. }, amount, .. }) = entry_of(&record) else { return Err(guest("that isn't a stake")) };
    append(LedgerKind::Unstake { stake: input.stake, delisting: input.delisting }, amount)
}

/// Whether the caller has decided this part of a hold yet.
#[hdk_extern]
pub fn have_i_decided(input: WaiveInput) -> ExternResult<bool> {
    Ok(my_decision(&input.hold, input.portion)?.is_some())
}

/// A part waived back to its payer.
#[derive(Serialize, Deserialize, Debug)]
pub struct WaiverView {
    pub waiver: ActionHash,
    pub portion: Portion,
    pub by: AgentPubKey,
}

/// The waivers of a hold's parts.
#[hdk_extern]
pub fn waivers_for_hold(hold: ActionHash) -> ExternResult<Vec<WaiverView>> {
    let mut waivers = Vec::new();
    for link in get_links(LinkQuery::try_new(hold.clone(), LinkTypes::HoldToWaive)?, GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash.clone(), GetOptions::default())? else { continue };
        if let Some(LedgerEntry { kind: LedgerKind::Waive { hold: h, portion }, .. }) = entry_of(&record) {
            if h == hold {
                waivers.push(WaiverView { waiver: hash, portion, by: record.action().author().clone() });
            }
        }
    }
    Ok(waivers)
}

// --- reading ---

/// `agent`'s balance: the balance on their latest ledger entry, which
/// validation ties to every entry before it on their chain. 0 before any.
#[hdk_extern]
pub fn get_balance(agent: AgentPubKey) -> ExternResult<i64> {
    if agent == agent_info()?.agent_initial_pubkey {
        return Ok(my_entries()?.last().and_then(entry_of).map_or(0, |e| e.balance));
    }
    let filter = ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::LedgerEntry)?);
    let activity = relay_coordinator_support::agent_activity(agent, filter)?;
    let Some((_, latest)) = activity.last() else { return Ok(0) };
    let record = get(latest.clone(), GetOptions::default())?.ok_or(guest("couldn't read their latest ledger entry"))?;
    Ok(entry_of(&record).map_or(0, |e| e.balance))
}

const LEDGER_PAGE_SIZE: usize = 50;

#[derive(Serialize, Deserialize, Debug)]
pub struct MyLedgerInput {
    /// Page cursor: the previous page's `next_before`. `None` starts with
    /// the newest entry.
    pub before: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LedgerPage {
    /// Newest first.
    pub entries: Vec<Record>,
    pub next_before: Option<u32>,
}

/// The caller's ledger, newest first -- every hold, collection, waiver and
/// deposit, each with the balance it left them with.
#[hdk_extern]
pub fn list_my_ledger(input: MyLedgerInput) -> ExternResult<LedgerPage> {
    let mut entries: Vec<Record> = my_entries()?.into_iter().filter(|r| input.before.is_none_or(|before| r.action().action_seq() < before)).collect();
    entries.reverse();
    let next_before = (entries.len() > LEDGER_PAGE_SIZE).then(|| entries[LEDGER_PAGE_SIZE - 1].action().action_seq());
    entries.truncate(LEDGER_PAGE_SIZE);
    Ok(LedgerPage { entries, next_before })
}

/// The caller's holds for an order -- what a receipt lists as paid.
#[hdk_extern]
pub fn my_holds_for_order(order: ActionHash) -> ExternResult<Vec<HoldView>> {
    let me = agent_info()?.agent_initial_pubkey;
    Ok(holds_for_order(order)?.into_iter().filter(|h| h.payer == me).collect())
}

#[cfg(feature = "test-utils")]
mod test_utils {
    use hdk::prelude::*;
    use ledger_integrity::{EntryTypes, LedgerEntry, LinkTypes};
    relay_coordinator_support::raw_link_test_externs!(OrderToHold, HoldToWaive, AgentToGrant, IssuerToRedemption, RedemptionToOutcome, IssuerToProfile);

    /// Writes a cash-out's outcome exactly as given -- what a modified
    /// client could.
    #[hdk_extern]
    pub fn create_raw_redemption_outcome_for_testing(outcome: ledger_integrity::RedemptionOutcome) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::RedemptionOutcome(outcome))
    }

    /// Writes a ledger entry exactly as given -- what a modified client
    /// could -- so a test can prove what validation refuses.
    #[hdk_extern]
    pub fn create_raw_ledger_entry_for_testing(entry: LedgerEntry) -> ExternResult<ActionHash> {
        create_entry(&EntryTypes::LedgerEntry(entry))
    }
}
