//! Appeals of a store's decision (`dispatch_types::Appeal`): the customer
//! appeals the store's settlement to one of the network's arbiters, the
//! store answers, the arbiter rules -- and the network's issuer pays an
//! award out of the store's next cash-out (`get_rulings_against`).

use crate::issues::{decisions_of, parties_of};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, guest, open_chunked, original_action_of, seal_chunked};

/// The arbiter an order's appeal goes to: one of the network's, chosen by
/// the order itself -- so nobody picks the one they'd like.
fn arbiter_for(order: &ActionHash) -> ExternResult<AgentPubKey> {
    let arbiters = relay_governance::arbiters();
    if arbiters.is_empty() {
        return Err(guest("This network has no arbiters: the store's decision stands."));
    }
    let index = order.get_raw_39().iter().fold(0usize, |acc, b| acc.wrapping_mul(31).wrapping_add(*b as usize)) % arbiters.len();
    Ok(arbiters[index].clone())
}

fn order_total(order: &ActionHash) -> ExternResult<u64> {
    let record = get(order.clone(), GetOptions::default())?.ok_or(guest("order not found"))?;
    match (decode_or::<DeliveryOrder>(&record), decode_or::<PickupOrder>(&record)) {
        (Some(o), _) => Ok(o.order_total),
        (None, Some(o)) => Ok(o.order_total),
        _ => Err(guest("that isn't an order")),
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct FileAppealInput {
    pub order: ActionHash,
    /// What the customer asks for, beyond the store's refund.
    pub amount: u64,
    pub note: String,
    #[serde(default)]
    pub photo_data_uri: String,
}

/// The customer appealing their store's settlement.
#[hdk_extern]
pub fn file_appeal(input: FileAppealInput) -> ExternResult<ActionHash> {
    let order = original_action_of(input.order)?;
    let me = agent_info()?.agent_initial_pubkey;
    let (customer, _) = parties_of(&order)?;
    if customer != me {
        return Err(guest("Only the order's customer appeals it."));
    }
    let Some((settlement, refund)) = decisions_of(&order)?.settlement else {
        return Err(guest("The store hasn't settled this order yet. Report the problem to the store first."));
    };
    let kept = order_total(&order)?.saturating_sub(refund);
    if input.amount == 0 || input.amount > kept {
        return Err(guest(format!("You can ask for up to what the store kept: {kept_cents}.", kept_cents = kept)));
    }
    if appeal_of(&order)?.is_some() {
        return Err(guest("You've already appealed this order."));
    }
    let arbiter = arbiter_for(&order)?;
    let (_, store_owner) = parties_of(&order)?;
    let evidence = IssueEvidence { note: input.note, photo_data_uri: input.photo_data_uri };
    let appeal = Appeal { order: order.clone(), settlement, arbiter: arbiter.clone(), amount: input.amount, sealed_for_arbiter: seal_chunked(&arbiter, &evidence)? };
    let hash = create_entry(&EntryTypes::Appeal(appeal))?;
    create_link(order, hash.clone(), LinkTypes::OrderToAppeal, ())?;
    create_link(arbiter, hash.clone(), LinkTypes::ArbiterToAppeal, ())?;
    create_link(store_owner, hash.clone(), LinkTypes::StoreOwnerToAppeal, ())?;
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct AnswerAppealInput {
    pub appeal: ActionHash,
    pub note: String,
    #[serde(default)]
    pub photo_data_uri: String,
}

/// The store giving its side, to the arbiter.
#[hdk_extern]
pub fn answer_appeal(input: AnswerAppealInput) -> ExternResult<ActionHash> {
    let (appeal, _, _) = read_appeal(&input.appeal)?;
    let evidence = IssueEvidence { note: input.note, photo_data_uri: input.photo_data_uri };
    let answer = AppealAnswer { appeal: input.appeal.clone(), sealed_for_arbiter: seal_chunked(&appeal.arbiter, &evidence)? };
    let hash = create_entry(&EntryTypes::AppealAnswer(answer))?;
    create_link(input.appeal, hash.clone(), LinkTypes::AppealToAnswer, ())?;
    Ok(hash)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RuleInput {
    pub appeal: ActionHash,
    /// Zero dismisses the appeal.
    pub award: u64,
    pub reasons: String,
}

/// The arbiter's ruling.
#[hdk_extern]
pub fn rule_on_appeal(input: RuleInput) -> ExternResult<ActionHash> {
    let (appeal, _, _) = read_appeal(&input.appeal)?;
    if appeal.arbiter != agent_info()?.agent_initial_pubkey {
        return Err(guest("Only the appeal's arbiter rules on it."));
    }
    if ruling_of(&input.appeal, &appeal.arbiter)?.is_some() {
        return Err(guest("You've already ruled on this appeal."));
    }
    let (_, store_owner) = parties_of(&appeal.order)?;
    let ruling = Ruling { appeal: input.appeal.clone(), award: input.award.min(appeal.amount), reasons: input.reasons };
    let hash = create_entry(&EntryTypes::Ruling(ruling))?;
    create_link(input.appeal, hash.clone(), LinkTypes::AppealToRuling, ())?;
    create_link(store_owner, hash.clone(), LinkTypes::StoreOwnerToRuling, ())?;
    Ok(hash)
}

fn read_appeal(hash: &ActionHash) -> ExternResult<(Appeal, AgentPubKey, Timestamp)> {
    let record = get(hash.clone(), GetOptions::default())?.ok_or(guest("No such appeal."))?;
    let appeal = decode_or::<Appeal>(&record).ok_or(guest("That isn't an appeal."))?;
    Ok((appeal, record.action().author().clone(), record.action().timestamp()))
}

/// The appeal of `order` (its original action), by its customer.
fn appeal_of(order: &ActionHash) -> ExternResult<Option<ActionHash>> {
    let (customer, _) = parties_of(order)?;
    Ok(get_links(LinkQuery::try_new(order.clone(), LinkTypes::OrderToAppeal)?.author(customer), GetStrategy::default())?.into_iter().find_map(|link| link.target.into_action_hash()))
}

/// The ruling on an appeal, by its arbiter.
fn ruling_of(appeal: &ActionHash, arbiter: &AgentPubKey) -> ExternResult<Option<(ActionHash, Ruling, Timestamp)>> {
    for link in get_links(LinkQuery::try_new(appeal.clone(), LinkTypes::AppealToRuling)?.author(arbiter.clone()), GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        if let Some(record) = get(hash.clone(), GetOptions::default())? {
            if let Some(ruling) = decode_or::<Ruling>(&record) {
                return Ok(Some((hash, ruling, record.action().timestamp())));
            }
        }
    }
    Ok(None)
}

/// The store's answer to an appeal, if it's given one.
fn answer_of(appeal: &ActionHash, store_owner: &AgentPubKey) -> ExternResult<Option<AppealAnswer>> {
    for link in get_links(LinkQuery::try_new(appeal.clone(), LinkTypes::AppealToAnswer)?.author(store_owner.clone()), GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        if let Some(answer) = get(hash, GetOptions::default())?.and_then(|r| decode_or::<AppealAnswer>(&r)) {
            return Ok(Some(answer));
        }
    }
    Ok(None)
}

/// An arbiter's ruling, as both sides see it.
#[derive(Serialize, Deserialize, Debug)]
pub struct RulingView {
    pub ruling: ActionHash,
    pub award: u64,
    pub reasons: String,
    pub ruled_at: Timestamp,
}

/// An appeal, as its customer, store and arbiter see it -- each side's
/// evidence only to whoever can open it.
#[derive(Serialize, Deserialize, Debug)]
pub struct AppealView {
    pub appeal: ActionHash,
    pub order: ActionHash,
    pub customer: AgentPubKey,
    pub store_owner: AgentPubKey,
    pub arbiter: AgentPubKey,
    pub amount: u64,
    pub order_total: u64,
    /// What the store refunded.
    pub refund: u64,
    pub filed_at: Timestamp,
    pub answered: bool,
    pub customer_evidence: Option<IssueEvidence>,
    pub store_evidence: Option<IssueEvidence>,
    pub ruling: Option<RulingView>,
}

fn view(hash: ActionHash) -> ExternResult<Option<AppealView>> {
    let (appeal, customer, filed_at) = read_appeal(&hash)?;
    let (order_customer, store_owner) = parties_of(&appeal.order)?;
    if customer != order_customer {
        return Ok(None);
    }
    let me = agent_info()?.agent_initial_pubkey;
    let answer = answer_of(&hash, &store_owner)?;
    // Sealed to the arbiter: they open it with its writer's key; the
    // writer, with the arbiter's.
    let open = |sealed: &relay_integrity_support::SealedChunks, writer: &AgentPubKey| -> ExternResult<Option<IssueEvidence>> {
        if me == appeal.arbiter {
            open_chunked(writer, sealed)
        } else if &me == writer {
            open_chunked(&appeal.arbiter, sealed)
        } else {
            Ok(None)
        }
    };
    let customer_evidence = open(&appeal.sealed_for_arbiter, &customer)?;
    let store_evidence = match &answer {
        Some(a) => open(&a.sealed_for_arbiter, &store_owner)?,
        None => None,
    };
    let refund = decisions_of(&appeal.order)?.settlement.map_or(0, |(_, refund)| refund);
    Ok(Some(AppealView {
        order_total: order_total(&appeal.order)?,
        ruling: ruling_of(&hash, &appeal.arbiter)?.map(|(ruling, r, ruled_at)| RulingView { ruling, award: r.award, reasons: r.reasons, ruled_at }),
        appeal: hash,
        order: appeal.order,
        customer,
        store_owner,
        arbiter: appeal.arbiter,
        amount: appeal.amount,
        refund,
        filed_at,
        answered: answer.is_some(),
        customer_evidence,
        store_evidence,
    }))
}

/// An order's appeal, if it has one.
#[hdk_extern]
pub fn get_appeal_for_order(order: ActionHash) -> ExternResult<Option<AppealView>> {
    let order = original_action_of(order)?;
    match appeal_of(&order)? {
        Some(hash) => view(hash),
        None => Ok(None),
    }
}

/// How many appeals a page reads in full.
const APPEALS_PAGE_SIZE: usize = 20;

#[derive(Serialize, Deserialize, Debug)]
pub struct AppealsInput {
    /// Appeals filed before this, for the next page; `None` for the first.
    pub before: Option<Timestamp>,
}

/// One newest-first page of appeals, open ones first within it.
#[derive(Serialize, Deserialize, Debug)]
pub struct AppealsPage {
    pub appeals: Vec<AppealView>,
    /// Where the next page starts, if there's one.
    pub next_before: Option<Timestamp>,
}

/// The appeals linked from `base` filed before `before`, newest first, a
/// page at a time -- an arbiter's or a busy store's list grows for good.
/// Keeps those `keep` accepts; `open` sorts first.
fn appeal_page(base: AgentPubKey, link_type: LinkTypes, before: Option<Timestamp>, keep: impl Fn(&AppealView) -> bool, open: impl Fn(&AppealView) -> bool) -> ExternResult<AppealsPage> {
    let mut query = LinkQuery::try_new(base, link_type)?;
    query.before = before;
    let (links, next_before) = relay_coordinator_support::links::newest_first_page(query, APPEALS_PAGE_SIZE)?;
    let mut appeals = Vec::with_capacity(links.len());
    for link in links {
        let Some(hash) = link.target.into_action_hash() else { continue };
        if let Some(v) = view(hash)?.filter(&keep) {
            appeals.push(v);
        }
    }
    appeals.sort_by_key(|v| (!open(v), std::cmp::Reverse(v.filed_at)));
    Ok(AppealsPage { appeals, next_before })
}

/// The appeals before the caller, an arbiter -- newest first, a page at a
/// time, open ones first in each.
#[hdk_extern]
pub fn get_my_docket(input: AppealsInput) -> ExternResult<AppealsPage> {
    appeal_page(agent_info()?.agent_initial_pubkey, LinkTypes::ArbiterToAppeal, input.before, |_| true, |v| v.ruling.is_none())
}

/// Appeals of the caller's decisions as a store owner -- newest first, a
/// page at a time, unanswered first in each.
#[hdk_extern]
pub fn get_appeals_against_me(input: AppealsInput) -> ExternResult<AppealsPage> {
    let me = agent_info()?.agent_initial_pubkey;
    appeal_page(me.clone(), LinkTypes::StoreOwnerToAppeal, input.before, |v| v.store_owner == me, |v| !v.answered && v.ruling.is_none())
}

/// A ruling a store's owner pays from their cash-outs.
#[derive(Serialize, Deserialize, Debug)]
pub struct RulingDue {
    pub ruling: ActionHash,
    pub appeal: ActionHash,
    pub order: ActionHash,
    pub customer: AgentPubKey,
    pub award: u64,
    pub ruled_at: Timestamp,
}

/// Every award against `owner`'s stores, by the arbiters of the appeals
/// they rule on -- what the issuer takes from that owner's cash-outs and
/// pays to each customer, once.
#[hdk_extern]
pub fn get_rulings_against(owner: AgentPubKey) -> ExternResult<Vec<RulingDue>> {
    let mut due = Vec::new();
    for link in get_links(LinkQuery::try_new(owner.clone(), LinkTypes::StoreOwnerToRuling)?, GetStrategy::Network)? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash.clone(), GetOptions::network())? else { continue };
        let Some(ruling) = decode_or::<Ruling>(&record) else { continue };
        let Ok((appeal, customer, _)) = read_appeal(&ruling.appeal) else { continue };
        let (order_customer, store_owner) = parties_of(&appeal.order)?;
        if record.action().author() != &appeal.arbiter || store_owner != owner || customer != order_customer || ruling.award == 0 {
            continue;
        }
        due.push(RulingDue { ruling: hash, appeal: ruling.appeal, order: appeal.order, customer, award: ruling.award, ruled_at: record.action().timestamp() });
    }
    due.sort_by_key(|r| r.ruled_at);
    Ok(due)
}
