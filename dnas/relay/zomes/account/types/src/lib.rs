//! An account's entries, factored out of `account_integrity` so other zomes
//! (and the issuer's service) can decode them -- same reasoning as
//! `ledger_types`.
//!
//! An account is a line of agent keys: someone's first key, and each key
//! that took over from the one before (`Succession`). A key is lost with its
//! device, and nothing on a peer-to-peer network can bring it back, so what
//! carries an account on is a *new* key, with authority to speak for the old
//! one:
//!
//! - **a hand-over**, signed by the old key itself (its final ledger entry,
//!   `ledger_types::LedgerKind::HandOver`) -- moving to a new device while
//!   the old one still works;
//! - **the recovery phrase**: a key derived from words the person wrote
//!   down, whose public half their `RecoveryPlan` names;
//! - **guardians**: enough of the people their plan names vouching
//!   (`Vouch`), each from their own chain.

use hdi::prelude::*;
pub use relay_integrity_support::limits::{MAX_GUARDIANS, MAX_PARCEL_BYTES};
pub use relay_integrity_support::SealedChunks;

/// How an account may be recovered if its key is lost: the phrase's key,
/// guardians, or both. The author's latest plan is the one that counts;
/// one with neither turns recovery off.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct RecoveryPlan {
    /// The public half of the key the person's recovery phrase derives --
    /// never the phrase, which stays on paper.
    pub phrase_key: Option<AgentPubKey>,
    /// People who can vouch for them, each by their own key.
    pub guardians: Vec<AgentPubKey>,
    /// How many guardians must vouch: none without guardians, otherwise
    /// between one and all of them.
    pub threshold: u8,
}

/// A guardian's word that the person now holding `successor` is the one
/// behind `account` -- after checking it's really them, outside the app.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct Vouch {
    pub account: AgentPubKey,
    pub successor: AgentPubKey,
    /// The account's plan that names the guardian.
    pub plan: ActionHash,
}

/// The author taking over `predecessor`'s account, on `authority`.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct Succession {
    pub predecessor: AgentPubKey,
    pub authority: Authority,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Authority {
    /// The predecessor's own hand-over: its final ledger entry, naming the
    /// author.
    HandOver { bequest: ActionHash },
    /// The recovery phrase: its key's signature over `phrase_message`.
    /// `plan` is the predecessor's latest plan as of `head`, an action on its
    /// chain -- where the account stood when it was recovered.
    Phrase { plan: ActionHash, head: ActionHash, signature: Signature },
    /// Guardians: at least the plan's threshold of them vouching for the
    /// author, under `plan` -- the predecessor's latest plan as of `head`.
    Guardians { plan: ActionHash, head: ActionHash, vouches: Vec<ActionHash> },
}

impl Authority {
    /// Whether this is a recovery (the old key lost), not a hand-over.
    pub fn is_recovery(&self) -> bool {
        !matches!(self, Authority::HandOver { .. })
    }
}

/// What a recovery phrase's key signs: a fixed label, the account, its new
/// key, and where the account stood -- never anything else, so the
/// signature can't stand for another message, account or moment.
pub fn phrase_message(predecessor: &AgentPubKey, successor: &AgentPubKey, head: &ActionHash) -> Vec<u8> {
    [PHRASE_LABEL, predecessor.get_raw_39(), b":", successor.get_raw_39(), b":", head.get_raw_39()].concat()
}

/// See `phrase_message`.
pub const PHRASE_LABEL: &[u8] = b"relay-recovery:v1:";

/// What a key handing over its account passes on, sealed to its successor:
/// what only the person could read before (their name, phone, addresses),
/// which the old key alone could open. Its contents are the app's own.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct Parcel {
    pub successor: AgentPubKey,
    pub sealed: SealedChunks,
}

/// The author moving their account to the next version of the network --
/// `network`, a different DNA (see MIGRATION.md). Written just before the
/// author closes their chain (`close_chain`), after which Holochain itself
/// accepts nothing more from it here: whatever the account held stays
/// exactly as it was. `successor` is the key that carries the account on
/// there, which an issuer credits with what the ledger held at the close,
/// once.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct Migration {
    pub network: DnaHash,
    pub successor: AgentPubKey,
}

/// The author arriving on this network from its previous version, as the
/// account `previous_account` there -- whose `Migration` (`migration`, on
/// that network) names the author. This network's validation can't read
/// another's, so apps check it there (the app carries the previous network
/// as its `previous` role) before counting the old account's history as
/// the author's.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct Arrival {
    pub previous_network: DnaHash,
    pub previous_account: AgentPubKey,
    pub migration: ActionHash,
}
