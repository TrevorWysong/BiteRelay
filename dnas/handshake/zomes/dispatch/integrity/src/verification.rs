//! Driver verification: a verifier's time-limited word that a driver passed
//! its checks (`dispatch_types::DriverVerification`), and the bids that
//! cite it.

use super::*;
use dispatch_types::{DriverVerification, VerificationCheck};
use handshake_integrity_support::{decode, invalid, linked_record, require};
use crate::links::OpLinkFields;

/// A verification is written by one of the network's verifiers, about
/// someone else, for no longer than the network allows.
pub(crate) fn validate_verification(verification: &DriverVerification, author: &AgentPubKey, timestamp: Timestamp) -> ExternResult<ValidateCallbackResult> {
    if !handshake_governance::is_verifier(author) {
        return invalid("only the network's verifiers verify drivers");
    }
    if &verification.driver == author {
        return invalid("a verifier can't verify themselves");
    }
    let mut checks: Vec<VerificationCheck> = verification.checks.clone();
    checks.sort_by_key(|c| *c as u8);
    checks.dedup();
    if verification.checks.is_empty() || checks.len() != verification.checks.len() {
        return invalid("a verification names each check it made, once");
    }
    let latest = (timestamp + handshake_governance::verification_lifetime()).map_err(|e| wasm_error!(WasmErrorInner::Guest(e.to_string())))?;
    require(
        verification.expires_at > timestamp && verification.expires_at <= latest,
        "a verification expires in the future, within the network's verification_days",
    )
}

/// A verifier revokes their own verification by deleting it.
pub(crate) fn validate_verification_delete(deleted: &ActionHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let record = must_get_valid_record(deleted.clone())?;
    if decode::<DriverVerification>(&record).is_none() {
        return invalid("dispatch entries can't be deleted");
    }
    require(record.action().author() == author, "only its verifier revokes a verification")
}

/// Why a bid can't stand on its verification, if it can't: where the
/// network requires one, it must be a verifier's, about this driver, and
/// current when they bid.
pub(crate) fn bid_verification_problem(bid: &Bid, timestamp: Timestamp) -> ExternResult<Option<String>> {
    let Some(cited) = &bid.verification else {
        return Ok(handshake_governance::require_verified_drivers().then(|| "this network's drivers are verified before they bid".into()));
    };
    let record = must_get_valid_record(cited.clone())?;
    let Some(verification) = decode::<DriverVerification>(&record) else {
        return Ok(Some("verification is not a DriverVerification".into()));
    };
    if !handshake_governance::is_verifier(record.action().author()) || verification.driver != bid.bidder {
        return Ok(Some("a bid cites a verifier's verification of its own driver".into()));
    }
    Ok((verification.expires_at <= timestamp).then(|| "the driver's verification has expired".into()))
}

/// A driver's verifications are found under them, linked by the verifier.
pub(crate) fn validate_verification_link(link: &OpLinkFields<'_>) -> ExternResult<ValidateCallbackResult> {
    let Some(record) = linked_record(link.target)? else { return invalid("target is not a record") };
    let Some(verification) = decode::<DriverVerification>(&record) else { return invalid("target is not a DriverVerification") };
    require(
        record.action().author() == link.author && link.base == &AnyLinkableHash::from(verification.driver),
        "a verification is linked under its driver by its verifier",
    )
}
