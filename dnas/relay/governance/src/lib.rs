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
    pub arbitrators: Vec<String>,
}

/// A real bug, found only by testing a code path no existing test had
/// actually exercised: `try_from_dna_properties()` *errors* (doesn't
/// return an empty/default value) when `dna.yaml`'s `properties:` is `~`
/// (the literal default this DNA ships with -- a real arbitrator roster
/// is only baked in at build time for a production deployment, per this
/// crate's own doc comment). Every *existing* call site happened to avoid
/// this: the dispute-flow tests explicitly configure a roster via
/// `rolesSettings`, and every other caller of `is_arbitrator` is gated
/// behind `&&` short-circuiting on an `author_is_party`/similar check that
/// was already `true`, so this branch was simply never reached. It's
/// reached for real by `ledger_integrity::validate_transaction`'s
/// third-party-author exception whenever that *isn't* already true -- a
/// perfectly ordinary, non-dispute payment authored by neither of its own
/// two parties (see that function's own doc comment for the real case:
/// `settle_delivery_fee`'s merchant-subsidy transaction). "No roster
/// configured yet" is a legitimate, common deployment state, not an
/// error -- it just means nobody is an arbitrator, which is exactly what
/// returning `false` here already says correctly.
pub fn is_arbitrator(agent: &AgentPubKey) -> ExternResult<bool> {
    let Ok(props) = RelayDnaProperties::try_from_dna_properties() else {
        return Ok(false);
    };
    Ok(props.arbitrators.contains(&agent.to_string()))
}
