//! Cashing out: a store or driver asking an issuer to pay part of their
//! balance out of the network, the issuer's record of what it did, and a
//! declined cash-out coming back. The ledger never moves real money -- an
//! issuer does, through its payment processor (Stripe Connect for cards and
//! banks; HoloFuel, later) -- so all the network holds is the request, its
//! outcome, and every balance staying the arithmetic of its owner's chain.
//! See `ledger_integrity` for the rules.

use crate::{append, guest, my_entries};
use hdk::prelude::*;
use ledger_integrity::*;
use relay_coordinator_support::{decode_or, next_page_cursor, open, seal};

// --- issuers ---

/// An issuer on the network's roster, and what it says about itself.
#[derive(Serialize, Deserialize, Debug)]
pub struct IssuerView {
    pub issuer: AgentPubKey,
    /// `None` until it publishes one: it can still pay out.
    pub profile: Option<IssuerProfile>,
}

/// The network's issuers, with their profiles -- who a cash-out can go to.
#[hdk_extern]
pub fn list_issuers(_: ()) -> ExternResult<Vec<IssuerView>> {
    relay_governance::issuers().into_iter().map(|issuer| Ok(IssuerView { profile: profile_of(&issuer)?.map(|(_, p)| p), issuer })).collect()
}

/// An issuer's profile at its latest, and its original action.
fn profile_of(issuer: &AgentPubKey) -> ExternResult<Option<(ActionHash, IssuerProfile)>> {
    for link in get_links(LinkQuery::try_new(issuer.clone(), LinkTypes::IssuerToProfile)?, GetStrategy::default())? {
        if &link.author != issuer {
            continue;
        }
        let Some(original) = link.target.into_action_hash() else { continue };
        let Ok(record) = relay_coordinator_support::resolve_latest(original.clone()) else { continue };
        if let Some(profile) = decode_or::<IssuerProfile>(&record) {
            return Ok(Some((original, profile)));
        }
    }
    Ok(None)
}

/// The caller, an issuer, publishing or changing its profile.
#[hdk_extern]
pub fn set_issuer_profile(profile: IssuerProfile) -> ExternResult<ActionHash> {
    let me = agent_info()?.agent_initial_pubkey;
    if !relay_governance::is_issuer(&me)? {
        return Err(guest("Only an issuer on this network's roster has an issuer profile."));
    }
    match profile_of(&me)? {
        Some((original, _)) => {
            let latest = relay_coordinator_support::resolve_latest(original)?;
            update_entry(latest.action_address().clone(), &EntryTypes::IssuerProfile(profile))
        }
        None => {
            let created = create_entry(&EntryTypes::IssuerProfile(profile))?;
            create_link(me, created.clone(), LinkTypes::IssuerToProfile, ())?;
            Ok(created)
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct IssuerLinkInput {
    pub issuer: AgentPubKey,
    /// The issuer service's one-time nonce.
    pub nonce: String,
}

/// The caller's signature showing `issuer`'s service they hold their key --
/// over `ledger_types::issuer_link_message` and nothing else, for one of
/// the network's issuers, with a nonce of the shape a service issues.
#[hdk_extern]
pub fn sign_issuer_link(input: IssuerLinkInput) -> ExternResult<Signature> {
    if !relay_governance::is_issuer(&input.issuer)? {
        return Err(guest("That isn't one of this network's issuers."));
    }
    if !is_link_nonce(&input.nonce) {
        return Err(guest("That isn't a nonce an issuer's service would send."));
    }
    let me = agent_info()?.agent_initial_pubkey;
    sign_raw(me, issuer_link_message(&input.issuer, &input.nonce))
}

// --- the redeemer ---

#[derive(Serialize, Deserialize, Debug)]
pub struct CashOutInput {
    pub issuer: AgentPubKey,
    pub amount: u64,
    /// Where to pay, if the issuer needs telling (sealed to it). Empty for
    /// none.
    #[serde(default)]
    pub instructions: String,
}

/// Where a cash-out stands.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum CashOutStatus {
    /// Waiting on its issuer.
    Pending,
    /// Paid out of the network; `reference` traces it with the issuer.
    Paid { reference: String, at: Timestamp },
    /// Declined; its funds are on their way back to the balance.
    Declined { reason: String, at: Timestamp },
    /// Declined, and back in the balance.
    Returned { reason: String, at: Timestamp },
}

/// One of the caller's cash-outs.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CashOutView {
    pub redemption: ActionHash,
    pub issuer: AgentPubKey,
    pub amount: u64,
    pub requested_at: Timestamp,
    pub status: CashOutStatus,
}

/// The caller cashing `amount` out through `issuer`: their balance goes
/// down now; the issuer pays them, or declines and it comes back.
#[hdk_extern]
pub fn cash_out(input: CashOutInput) -> ExternResult<CashOutView> {
    let me = agent_info()?.agent_initial_pubkey;
    if !relay_governance::is_issuer(&input.issuer)? {
        return Err(guest("That isn't one of this network's issuers."));
    }
    if input.issuer == me {
        return Err(guest("An issuer pays out others, not itself."));
    }
    let min = relay_governance::min_redemption_cents().max(profile_of(&input.issuer)?.map_or(0, |(_, p)| p.min_payout_cents));
    if input.amount < min {
        return Err(guest(format!("You can cash out {min} or more at once.")));
    }
    if input.instructions.chars().count() > relay_integrity_support::limits::MAX_NOTE_CHARS {
        return Err(guest("Those payout instructions are too long."));
    }
    let instructions = match input.instructions.trim() {
        "" => None,
        text => Some(seal(&input.issuer, &text.to_string())?),
    };
    let redemption = append(LedgerKind::Redeem { issuer: input.issuer.clone(), instructions }, input.amount)?;
    create_link(input.issuer.clone(), redemption.clone(), LinkTypes::IssuerToRedemption, ())?;
    Ok(CashOutView { redemption, issuer: input.issuer, amount: input.amount, requested_at: sys_time()?, status: CashOutStatus::Pending })
}

/// The caller's cash-outs, newest first, each with where it stands.
#[hdk_extern]
pub fn list_my_cash_outs(_: ()) -> ExternResult<Vec<CashOutView>> {
    let entries: Vec<(Record, LedgerEntry)> = my_entries()?.into_iter().filter_map(|r| decode_or::<LedgerEntry>(&r).map(|e| (r, e))).collect();
    let returned: Vec<&ActionHash> = entries
        .iter()
        .filter_map(|(_, e)| match &e.kind {
            LedgerKind::Reclaim { redemption, .. } => Some(redemption),
            _ => None,
        })
        .collect();
    let mut views = Vec::new();
    for (record, entry) in entries.iter().rev() {
        let LedgerKind::Redeem { issuer, .. } = &entry.kind else { continue };
        let redemption = record.action_address().clone();
        let status = match outcome_of(&redemption, issuer)? {
            None => CashOutStatus::Pending,
            Some((_, outcome, at)) => match outcome {
                PayoutOutcome::Paid { reference } => CashOutStatus::Paid { reference, at },
                PayoutOutcome::Declined { reason } if returned.contains(&&redemption) => CashOutStatus::Returned { reason, at },
                PayoutOutcome::Declined { reason } => CashOutStatus::Declined { reason, at },
            },
        };
        views.push(CashOutView { redemption, issuer: issuer.clone(), amount: entry.amount, requested_at: record.action().timestamp(), status });
    }
    Ok(views)
}

/// Takes back every cash-out of the caller's that its issuer declined and
/// they haven't yet -- the app calls it as it shows the wallet. Returns how
/// many.
#[hdk_extern]
pub fn reclaim_declined_cash_outs(_: ()) -> ExternResult<u32> {
    let mut count = 0;
    for view in list_my_cash_outs(())? {
        if !matches!(view.status, CashOutStatus::Declined { .. }) {
            continue;
        }
        let Some((outcome, _, _)) = outcome_of(&view.redemption, &view.issuer)? else { continue };
        append(LedgerKind::Reclaim { redemption: view.redemption, outcome }, view.amount)?;
        count += 1;
    }
    Ok(count)
}

/// A cash-out's outcome, if its issuer has written one: the outcome's
/// action, what it says, and when.
fn outcome_of(redemption: &ActionHash, issuer: &AgentPubKey) -> ExternResult<Option<(ActionHash, PayoutOutcome, Timestamp)>> {
    for link in get_links(LinkQuery::try_new(redemption.clone(), LinkTypes::RedemptionToOutcome)?, GetStrategy::default())? {
        if &link.author != issuer {
            continue;
        }
        let Some(target) = link.target.into_action_hash() else { continue };
        let Some(record) = get(target.clone(), GetOptions::default())? else { continue };
        if let Some(outcome) = decode_or::<RedemptionOutcome>(&record).filter(|o| &o.redemption == redemption) {
            return Ok(Some((target, outcome.outcome, record.action().timestamp())));
        }
    }
    Ok(None)
}

// --- the issuer ---

/// Cash-outs an issuer sweeps at once.
const REQUESTS_PAGE_SIZE: usize = 100;

#[derive(Serialize, Deserialize, Debug)]
pub struct CashOutRequestsInput {
    /// Only those that arrived after this -- the previous page's `cursor`,
    /// which the issuer's service keeps between sweeps. `None` from the
    /// start.
    pub after: Option<Timestamp>,
}

/// A cash-out the caller, an issuer, has been asked to pay.
#[derive(Serialize, Deserialize, Debug)]
pub struct CashOutRequest {
    pub redemption: ActionHash,
    pub redeemer: AgentPubKey,
    pub amount: u64,
    pub requested_at: Timestamp,
    /// The redeemer's payout instructions, opened -- empty if none.
    pub instructions: String,
    /// What the issuer already decided, if it has.
    pub outcome: Option<PayoutOutcome>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CashOutRequestsPage {
    pub requests: Vec<CashOutRequest>,
    /// Just past the newest request on this page -- pass it back as `after`
    /// to carry on from here, now or on the next sweep. The input's `after`
    /// when the page is empty.
    pub cursor: Option<Timestamp>,
    /// Whether more have already arrived past `cursor`.
    pub more: bool,
}

/// The cash-outs the caller, an issuer, has been asked to pay, oldest first,
/// a page at a time -- what its payout service sweeps.
#[hdk_extern]
pub fn get_cash_out_requests(input: CashOutRequestsInput) -> ExternResult<CashOutRequestsPage> {
    let me = agent_info()?.agent_initial_pubkey;
    let mut query = LinkQuery::try_new(me.clone(), LinkTypes::IssuerToRedemption)?;
    query.after = input.after;
    let mut links = get_links(query, GetStrategy::default())?;
    links.sort_by_key(|l| l.timestamp);
    let more = links.len() > REQUESTS_PAGE_SIZE;
    links.truncate(REQUESTS_PAGE_SIZE);
    let cursor = links.last().map(|l| next_page_cursor(l.timestamp)).or(input.after);
    let mut requests = Vec::with_capacity(links.len());
    for link in links {
        let Some(redemption) = link.target.into_action_hash() else { continue };
        let Some(record) = get(redemption.clone(), GetOptions::default())? else { continue };
        let Some(LedgerEntry { kind: LedgerKind::Redeem { issuer, instructions }, amount, .. }) = decode_or::<LedgerEntry>(&record) else { continue };
        if issuer != me {
            continue;
        }
        let redeemer = record.action().author().clone();
        let instructions = match &instructions {
            Some(sealed) => open::<String>(&redeemer, sealed)?.unwrap_or_default(),
            None => String::new(),
        };
        let outcome = outcome_of(&redemption, &me)?.map(|(_, outcome, _)| outcome);
        requests.push(CashOutRequest { redemption, redeemer, amount, requested_at: record.action().timestamp(), instructions, outcome });
    }
    Ok(CashOutRequestsPage { requests, cursor, more })
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DecideCashOutInput {
    pub redemption: ActionHash,
    pub outcome: PayoutOutcome,
}

/// The caller, an issuer, recording what it did with a cash-out -- once:
/// paid (after its processor confirmed the transfer), or declined.
#[hdk_extern]
pub fn decide_cash_out(input: DecideCashOutInput) -> ExternResult<ActionHash> {
    let me = agent_info()?.agent_initial_pubkey;
    if outcome_of(&input.redemption, &me)?.is_some() {
        return Err(guest("That cash-out has already been decided."));
    }
    let outcome = create_entry(&EntryTypes::RedemptionOutcome(RedemptionOutcome { redemption: input.redemption.clone(), outcome: input.outcome }))?;
    create_link(input.redemption, outcome.clone(), LinkTypes::RedemptionToOutcome, ())?;
    Ok(outcome)
}
