//! The network's settings, baked into the DNA's `properties` (`dna.yaml`'s
//! `properties:` field), which *is* part of the DNA hash (confirmed via
//! `holochain_integrity_types::DnaModifiers`, not the separate,
//! per-install-only `init_properties` mechanism also present in this
//! hdi/hdk version -- that one is never DHT-agreed, so it's the wrong tool
//! for something every validator needs to check identically). Everyone on a
//! network runs by the same settings; changing them means shipping a new DNA
//! version that people move to.
//!
//! Every setting is optional, defaulting to the value below -- so a network
//! states only what it changes. There is no one with special powers here
//! other than the issuers who bring money into the ledger: orders settle on
//! proof, on the customer's claim, and on the store's decision (see
//! `dispatch_types::issues`).
//!
//! `#[dna_properties]` (re-exported from `hdk_derive` via `hdi::prelude`)
//! generates the `TryFromDnaProperties` impl that reads
//! `dna_info()?.modifiers.properties` -- real, current, and callable from
//! deterministic `validate()`, unlike `get_links`-based lookups would be.

use core::time::Duration;
use hdi::prelude::*;

/// Agent keys here are strings (each the standard `"u..."` base64 hash
/// string -- `AgentPubKey`'s own `Display` impl, matching
/// `@holochain/client`'s `encodeHashToBase64`), not `AgentPubKey`s: a raw
/// hash's bytes nested inside this admin-install-time properties value don't
/// round-trip cleanly through the JS client's request encoder, while strings
/// do.
#[dna_properties]
pub struct RelayDnaProperties {
    /// Who may issue funds into the ledger (`ledger_integrity::IssuerGrant`)
    /// -- the network's stand-in for a payment processor topping up an
    /// account against a real card payment.
    #[serde(default)]
    pub issuers: Vec<String>,
    /// How far below zero any agent's balance may go, in minor units of the
    /// currency. A production network sets this explicitly -- 0 means
    /// everything is prepaid. Unset, it's a development allowance.
    #[serde(default)]
    pub credit_limit_cents: Option<u64>,
    /// The ISO 4217 code of the currency every amount is in, in its minor
    /// units ("cents" for USD). Display only: the ledger is unit-agnostic.
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub store_response_secs: Option<u64>,
    #[serde(default)]
    pub report_window_secs: Option<u64>,
    #[serde(default)]
    pub answer_grace_secs: Option<u64>,
    #[serde(default)]
    pub claim_grace_secs: Option<u64>,
    #[serde(default)]
    pub max_code_attempts: Option<u32>,
    #[serde(default)]
    pub default_prep_minutes: Option<u16>,
    #[serde(default)]
    pub max_prep_minutes: Option<u16>,
    #[serde(default)]
    pub max_image_bytes: Option<usize>,
    #[serde(default)]
    pub goodie_bag_max_days: Option<u16>,
    #[serde(default)]
    pub clock_tolerance_secs: Option<u64>,
    #[serde(default)]
    pub price_change_grace_secs: Option<u64>,
    #[serde(default)]
    pub default_delivery_radius_km: Option<f64>,
    #[serde(default)]
    pub default_delivery_subsidy_percent: Option<u8>,
    #[serde(default)]
    pub max_delivery_radius_km: Option<f64>,
}

fn properties() -> Option<RelayDnaProperties> {
    RelayDnaProperties::try_from_dna_properties().ok()
}

/// A setting, or its default.
fn setting<T>(read: impl FnOnce(RelayDnaProperties) -> Option<T>, default: T) -> T {
    properties().and_then(read).unwrap_or(default)
}

// --- money ---

/// The development allowance when a DNA doesn't set `credit_limit_cents`:
/// enough to order freely in a demo. `web/scripts/package.mjs` refuses to
/// build a network bundle without an explicit limit.
const DEVELOPMENT_CREDIT_LIMIT_CENTS: u64 = 1_000_000;

/// How far below zero a balance may go.
pub fn credit_limit_cents() -> u64 {
    setting(|p| p.credit_limit_cents, DEVELOPMENT_CREDIT_LIMIT_CENTS)
}

/// Whether `agent` may issue funds -- see `RelayDnaProperties::issuers`. A
/// DNA built without properties (`properties: ~`, the default outside
/// production) has no issuers.
pub fn is_issuer(agent: &AgentPubKey) -> ExternResult<bool> {
    Ok(properties().is_some_and(|p| p.issuers.contains(&agent.to_string())))
}

/// The network's currency (ISO 4217).
pub fn currency() -> String {
    setting(|p| p.currency, "USD".into())
}

// --- orders ---

/// How long a store has to accept an order once it's placed with it. After
/// that the store can't, and the customer's conductor cancels it -- so a
/// customer never waits on a store that's offline.
pub fn store_response_window() -> Duration {
    Duration::from_secs(setting(|p| p.store_response_secs, 5 * 60))
}

/// A new store's usual prep time, until it sets its own.
pub fn default_prep_minutes() -> u16 {
    setting(|p| p.default_prep_minutes, 15)
}

/// The longest a store may say an order will take to prepare -- both its
/// usual prep time and a promise when it accepts an order.
pub fn max_prep_minutes() -> u16 {
    setting(|p| p.max_prep_minutes, 4 * 60)
}

/// How far an author's clock may be from the moment it claims, where a rule
/// compares the two (a goodie bag's listing time, a claim's, an order dated
/// ahead of the store accepting it).
pub fn clock_tolerance() -> Duration {
    Duration::from_secs(setting(|p| p.clock_tolerance_secs, 10 * 60))
}

/// How long after a menu item's price changes a store still accepts an order
/// priced from the old one -- a customer mid-checkout isn't refused for it.
pub fn price_change_grace() -> Duration {
    Duration::from_secs(setting(|p| p.price_change_grace_secs, 15 * 60))
}

/// A new store's delivery radius, until it sets its own.
pub fn default_delivery_radius_km() -> f64 {
    setting(|p| p.default_delivery_radius_km, 8.0)
}

/// A new store's share of each delivery fee, in percent, until it sets its
/// own.
pub fn default_delivery_subsidy_percent() -> u8 {
    setting(|p| p.default_delivery_subsidy_percent, 50).min(100)
}

/// The furthest any store may deliver.
pub fn max_delivery_radius_km() -> f64 {
    setting(|p| p.max_delivery_radius_km, 50.0)
}

/// The longest a goodie bag may stay listed.
pub fn goodie_bag_max_lifetime() -> Duration {
    Duration::from_secs(u64::from(setting(|p| p.goodie_bag_max_days, 7)) * 86_400)
}

// --- handoffs and settlement ---

/// How many wrong handoff codes a giver's conductor answers for one order
/// before it stops: a handful of tries can't find six digits, a million
/// could.
pub fn max_code_attempts() -> u32 {
    setting(|p| p.max_code_attempts, 5)
}

/// How long a customer has to report items missing or wrong once they have
/// their order. The store's app waits this long before settling the food's
/// payment -- a store's own clock, so it's the store's word, made visible.
pub fn report_window() -> Duration {
    Duration::from_secs(setting(|p| p.report_window_secs, 2 * 3_600))
}

/// However late a report comes, the store has at least this long to answer
/// it before its app settles the order -- never longer than the report
/// window itself.
pub fn answer_grace() -> Duration {
    Duration::from_secs(setting(|p| p.answer_grace_secs, 30 * 60)).min(report_window())
}

/// How long the store's app lets a customer's "never arrived" stand before
/// deciding it -- time for a driver running late to turn up and complete
/// the delivery. The store can decide sooner.
pub fn claim_grace() -> Duration {
    Duration::from_secs(setting(|p| p.claim_grace_secs, 30 * 60))
}

// --- content ---

/// The most an inline image may take, in bytes of its data URI.
pub fn max_image_bytes() -> usize {
    setting(|p| p.max_image_bytes, 300_000)
}
