//! The dispute/arbitration subsystem's one deliberate centralization point,
//! named as such rather than hidden -- see the architecture plan §8.1 for
//! why a decentralized jury isn't built here. A small, fixed roster of
//! trust-anchor arbitrator agents is baked into this DNA's `properties`
//! (`dna.yaml`'s `properties:` field), which *is* part of the DNA hash
//! (confirmed via `holochain_integrity_types::DnaModifiers`, not the
//! separate, per-install-only `init_properties` mechanism also present in
//! this hdi/hdk version -- that one is never DHT-agreed, so it's the wrong
//! tool for something every validator needs to check identically). Every
//! legitimate installer of this hApp gets the same roster baked in at build
//! time, which is what keeps everyone on the same DNA hash/network; changing
//! the roster later means shipping a new DNA version.
//!
//! `#[dna_properties]` (re-exported from `hdk_derive` via `hdi::prelude`)
//! generates the `TryFromDnaProperties` impl that reads
//! `dna_info()?.modifiers.properties` -- real, current, and callable from
//! deterministic `validate()`, unlike `get_links`-based lookups would be.

use hdi::prelude::*;

/// `arbitrators` is `Vec<String>` (each the standard `"u..."` base64 hash
/// string -- `AgentPubKey`'s own `Display` impl, matching
/// `@holochain/client`'s `encodeHashToBase64`), not `Vec<AgentPubKey>`.
/// A raw hash's bytes, nested inside this admin-install-time properties
/// value specifically, don't round-trip cleanly through the JS client's
/// request encoder (confirmed empirically: a bare string value works, a
/// nested `Uint8Array` does not, even though `AgentPubKey`s pass through
/// fine as *top-level* zome-call arguments elsewhere in this codebase).
/// Strings sidestep that quirk entirely and are exactly what the
/// `YamlProperties` channel this rides on is actually meant to carry.
#[dna_properties]
pub struct RelayDnaProperties {
    #[serde(default)]
    pub arbitrators: Vec<String>,
    /// How old a ledger transaction must be before a balance checkpoint may
    /// cover it -- see `balance_settle_window`. Defaults to an hour; tests
    /// set it low to exercise checkpoints.
    #[serde(default)]
    pub ledger_settle_secs: Option<u64>,
    /// How long a store has to accept a new order -- see
    /// `store_response_window`. Defaults to five minutes; tests set it low.
    #[serde(default)]
    pub store_response_secs: Option<u64>,
}

const DEFAULT_LEDGER_SETTLE_SECS: u64 = 3600;
const DEFAULT_STORE_RESPONSE_SECS: u64 = 300;

/// How long a store has to accept an order once it's placed with it. After
/// that the store can't, and the customer's conductor cancels it -- so a
/// customer never waits on a store that's offline.
pub fn store_response_window() -> core::time::Duration {
    let secs = RelayDnaProperties::try_from_dna_properties().ok().and_then(|p| p.store_response_secs).unwrap_or(DEFAULT_STORE_RESPONSE_SECS);
    core::time::Duration::from_secs(secs)
}

/// How long to wait before a balance checkpoint may cover a transaction:
/// long enough for gossip to deliver anything paid to an agent up to then,
/// so no payment can arrive *behind* a checkpoint and be missed.
pub fn balance_settle_window() -> core::time::Duration {
    let secs = RelayDnaProperties::try_from_dna_properties().ok().and_then(|p| p.ledger_settle_secs).unwrap_or(DEFAULT_LEDGER_SETTLE_SECS);
    core::time::Duration::from_secs(secs)
}

/// Whether `agent` is on the DNA's arbitrator roster. A DNA built without a
/// roster (`properties: ~`, the default outside production) makes
/// `try_from_dna_properties` error rather than return an empty roster; that
/// just means nobody is an arbitrator, so it reads as `false`.
pub fn is_arbitrator(agent: &AgentPubKey) -> ExternResult<bool> {
    let Ok(props) = RelayDnaProperties::try_from_dna_properties() else {
        return Ok(false);
    };
    Ok(props.arbitrators.contains(&agent.to_string()))
}
