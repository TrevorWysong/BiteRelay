//! A recovered account's balance, reissued by an issuer. Nothing on a
//! peer-to-peer network can prove a lost key is gone, nor that a recovery
//! phrase was used once -- so the money of a recovered account doesn't move
//! on the network's word: an issuer, which holds the money behind it,
//! reissues it once, after the old key has been quiet a while.

use crate::{decoded, guest, me};
use account_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::next_page_cursor;

/// Asks `issuer` to reissue the balance of the account the caller
/// recovered. Safe to repeat.
#[hdk_extern]
pub fn request_reissue(issuer: AgentPubKey) -> ExternResult<()> {
    let mine = crate::my_linked(LinkTypes::SuccessorToSuccession)?;
    let record = mine.first().ok_or(guest("This device hasn't recovered an account."))?;
    let hash = record.action_address().clone();
    let asked = LinkQuery::try_new(issuer.clone(), LinkTypes::IssuerToReissue)?.author(me()?);
    if get_links(asked, GetStrategy::Local)?.iter().any(|l| l.target.clone().into_action_hash().as_ref() == Some(&hash)) {
        return Ok(());
    }
    create_link(issuer, hash, LinkTypes::IssuerToReissue, ())?;
    Ok(())
}

const REQUESTS_PAGE_SIZE: usize = 50;

#[derive(Serialize, Deserialize, Debug)]
pub struct ReissueRequestsInput {
    pub after: Option<Timestamp>,
}

/// A recovered account an issuer has been asked to reissue.
#[derive(Serialize, Deserialize, Debug)]
pub struct ReissueRequest {
    pub succession: ActionHash,
    pub predecessor: AgentPubKey,
    pub successor: AgentPubKey,
    pub requested_at: Timestamp,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ReissueRequestsPage {
    pub requests: Vec<ReissueRequest>,
    /// As `CashOutRequestsPage::cursor`.
    pub cursor: Option<Timestamp>,
    pub more: bool,
}

/// The recovered accounts the caller, an issuer, has been asked to reissue,
/// oldest first, a page at a time.
#[hdk_extern]
pub fn get_reissue_requests(input: ReissueRequestsInput) -> ExternResult<ReissueRequestsPage> {
    let mut query = LinkQuery::try_new(me()?, LinkTypes::IssuerToReissue)?;
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
        let Some(succession) = decoded::<Succession>(&record) else { continue };
        requests.push(ReissueRequest { succession: hash, predecessor: succession.predecessor, successor: record.action().author().clone(), requested_at: link.timestamp });
    }
    Ok(ReissueRequestsPage { requests, cursor, more })
}
