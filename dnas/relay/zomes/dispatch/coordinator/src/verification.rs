//! Driver verification (`dispatch_types::DriverVerification`): a network's
//! verifiers vouch for drivers they've checked, for a time; drivers' bids
//! cite it; and customers' apps pass over bids whose verification its
//! verifier has since withdrawn -- what validation can't see.

use dispatch_integrity::*;
use hdk::prelude::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct VerifyDriverInput {
    pub driver: AgentPubKey,
    pub checks: Vec<VerificationCheck>,
    /// How long it lasts, in days -- at most the network's
    /// `verification_days`, which is the default.
    #[serde(default)]
    pub days: Option<u32>,
}

/// A verifier vouching for a driver they've checked.
#[hdk_extern]
pub fn verify_driver(input: VerifyDriverInput) -> ExternResult<ActionHash> {
    let me = agent_info()?.agent_initial_pubkey;
    if !relay_governance::is_verifier(&me) {
        return Err(guest("Only the network's verifiers verify drivers."));
    }
    let longest = relay_governance::verification_lifetime();
    let lifetime = input.days.map_or(longest, |days| core::time::Duration::from_secs(u64::from(days) * 86_400).min(longest));
    let expires_at = (sys_time()? + lifetime).map_err(|e| guest(&e.to_string()))?;
    let verification = DriverVerification { driver: input.driver.clone(), checks: input.checks, expires_at };
    let hash = create_entry(&EntryTypes::DriverVerification(verification))?;
    create_link(input.driver, hash.clone(), LinkTypes::DriverToVerification, ())?;
    Ok(hash)
}

/// A verifier withdrawing their verification -- the driver's bids stop
/// being accepted at once, wherever customers' apps see it.
#[hdk_extern]
pub fn revoke_verification(verification: ActionHash) -> ExternResult<()> {
    let record = get(verification.clone(), GetOptions::network())?.ok_or(guest("No such verification."))?;
    let Ok(Some(found)) = record.entry().to_app_option::<DriverVerification>() else { return Err(guest("That isn't a driver verification.")) };
    for link in get_links(LinkQuery::try_new(found.driver, LinkTypes::DriverToVerification)?, GetStrategy::Network)? {
        if link.target.clone().into_action_hash().as_ref() == Some(&verification) {
            delete_link(link.create_link_hash, GetOptions::network())?;
        }
    }
    delete_entry(verification)?;
    Ok(())
}

/// A driver's verification as their customers see it.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VerificationView {
    pub action: ActionHash,
    pub verifier: AgentPubKey,
    pub checks: Vec<VerificationCheck>,
    pub expires_at: Timestamp,
}

/// Whether a verification stands now: a verifier's, about `driver`, not
/// expired and not withdrawn.
fn standing(action: &ActionHash, driver: &AgentPubKey, now: Timestamp) -> ExternResult<Option<VerificationView>> {
    let Some(Details::Record(details)) = get_details(action.clone(), GetOptions::network())? else { return Ok(None) };
    if !details.deletes.is_empty() {
        return Ok(None);
    }
    let verifier = details.record.action().author().clone();
    let Ok(Some(verification)) = details.record.entry().to_app_option::<DriverVerification>() else { return Ok(None) };
    let current = relay_governance::is_verifier(&verifier) && &verification.driver == driver && verification.expires_at > now;
    Ok(current.then(|| VerificationView { action: action.clone(), verifier, checks: verification.checks, expires_at: verification.expires_at }))
}

/// A driver's current verification, the longest-lasting if several --
/// `None` if they have none standing.
#[hdk_extern]
pub fn driver_verification(driver: AgentPubKey) -> ExternResult<Option<VerificationView>> {
    let now = sys_time()?;
    let mut best: Option<VerificationView> = None;
    for link in get_links(LinkQuery::try_new(driver.clone(), LinkTypes::DriverToVerification)?, GetStrategy::Network)? {
        let Some(action) = link.target.into_action_hash() else { continue };
        if let Some(view) = standing(&action, &driver, now)? {
            if best.as_ref().is_none_or(|b| view.expires_at > b.expires_at) {
                best = Some(view);
            }
        }
    }
    Ok(best)
}

/// Whether the verification a bid cites still stands -- `true` for a bid
/// citing none on a network that doesn't ask for one.
pub(crate) fn bid_verification_stands(bid: &Bid) -> ExternResult<bool> {
    match &bid.verification {
        Some(action) => Ok(standing(action, &bid.bidder, sys_time()?)?.is_some()),
        None => Ok(!relay_governance::require_verified_drivers()),
    }
}

/// What the network asks of drivers, for the driver app.
#[derive(Serialize, Deserialize, Debug)]
pub struct VerificationTerms {
    pub required: bool,
    pub verifiers: Vec<AgentPubKey>,
}

#[hdk_extern]
pub fn get_verification_terms(_: ()) -> ExternResult<VerificationTerms> {
    Ok(VerificationTerms { required: relay_governance::require_verified_drivers(), verifiers: relay_governance::verifiers() })
}

fn guest(message: &str) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message.into()))
}
