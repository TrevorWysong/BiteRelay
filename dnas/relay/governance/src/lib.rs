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
    /// How long a store has to accept a new order -- see
    /// `store_response_window`. Defaults to five minutes; tests set it low.
    #[serde(default)]
    pub store_response_secs: Option<u64>,
    /// Who may issue funds into the ledger (`ledger_integrity::IssuerGrant`)
    /// -- the network's stand-in for a payment processor topping up an
    /// account against a real card payment. Same string form as
    /// `arbitrators`.
    #[serde(default)]
    pub issuers: Vec<String>,
    /// How far below zero any agent's balance may go, in cents. A
    /// production network sets this explicitly -- 0 means everything is
    /// prepaid, so a fresh identity has nothing to spend (see
    /// `credit_limit_cents`). Unset, it's a development allowance.
    #[serde(default)]
    pub credit_limit_cents: Option<u64>,
}

const DEFAULT_STORE_RESPONSE_SECS: u64 = 300;

/// The development allowance when a DNA doesn't set `credit_limit_cents`:
/// enough to order freely in a demo. `web/scripts/package.mjs` refuses to
/// build a network bundle without an explicit limit.
const DEVELOPMENT_CREDIT_LIMIT_CENTS: u64 = 1_000_000;

/// How long a store has to accept an order once it's placed with it. After
/// that the store can't, and the customer's conductor cancels it -- so a
/// customer never waits on a store that's offline.
pub fn store_response_window() -> core::time::Duration {
    let secs = RelayDnaProperties::try_from_dna_properties().ok().and_then(|p| p.store_response_secs).unwrap_or(DEFAULT_STORE_RESPONSE_SECS);
    core::time::Duration::from_secs(secs)
}

/// How far below zero a balance may go -- see `credit_limit_cents`.
pub fn credit_limit_cents() -> u64 {
    RelayDnaProperties::try_from_dna_properties().ok().and_then(|p| p.credit_limit_cents).unwrap_or(DEVELOPMENT_CREDIT_LIMIT_CENTS)
}

/// Whether `agent` may issue funds -- see `RelayDnaProperties::issuers`.
pub fn is_issuer(agent: &AgentPubKey) -> ExternResult<bool> {
    let Ok(props) = RelayDnaProperties::try_from_dna_properties() else {
        return Ok(false);
    };
    Ok(props.issuers.contains(&agent.to_string()))
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
