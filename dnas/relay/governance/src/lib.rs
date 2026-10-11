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
    #[serde(default)]
    pub max_concurrent_deliveries: Option<u32>,
    #[serde(default)]
    pub max_pending_orders: Option<u32>,
    #[serde(default)]
    pub default_bag_hold_minutes: Option<u16>,
    #[serde(default)]
    pub suggested_delivery_fees: Option<Vec<u64>>,
    #[serde(default)]
    pub store_listing_stake: Option<u64>,
    #[serde(default)]
    pub pickup_grace_secs: Option<u64>,
    #[serde(default)]
    pub collection_window_secs: Option<u64>,
    #[serde(default)]
    pub add_on_detour_km: Option<f64>,
    #[serde(default)]
    pub offer_secs: Option<u64>,
    #[serde(default)]
    pub store_wait_secs: Option<u64>,
    #[serde(default)]
    pub min_store_wait_secs: Option<u64>,
    #[serde(default)]
    pub max_driver_changes: Option<u32>,
    #[serde(default)]
    pub max_offers_per_order: Option<u32>,
    #[serde(default)]
    pub max_ranked_bids: Option<u32>,
    #[serde(default)]
    pub min_reporter_stores: Option<u32>,
    #[serde(default)]
    pub max_store_wait_secs: Option<u64>,
    #[serde(default)]
    pub replacement_window_secs: Option<u64>,
    #[serde(default)]
    pub bid_window_secs: Option<u64>,
    #[serde(default)]
    pub minute_value_cents: Option<u64>,
    /// The public time source deadlines are proved against -- see
    /// `TimeSource`. Unset, drand's quicknet.
    #[serde(default)]
    pub time_source: Option<TimeSource>,
}

/// A drand network (<https://drand.love>): a public randomness beacon run
/// jointly by independent organisations, publishing a value signed by all of
/// them every `period_secs`. Nobody can know a round's value before it's
/// published, so a record carrying one wasn't made before that round --
/// which is what a deadline claim needs to prove. Verified against
/// `public_key` alone: no network call, the same answer for every validator.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct TimeSource {
    /// The network's BLS public key (G2, compressed), hex -- its
    /// `bls-unchained-g1-rfc9380` scheme, as quicknet runs.
    pub public_key: String,
    /// When round 1 was published, in seconds since the Unix epoch.
    pub genesis_secs: u64,
    pub period_secs: u64,
    /// Where apps fetch rounds from (`{base}/{chain_hash}`-style relays);
    /// never consulted by validation.
    pub relays: Vec<String>,
    pub chain_hash: String,
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

/// The delivery fee caps checkout suggests, in minor units of the network's
/// currency -- set alongside `currency`. Suggestions only: a customer can
/// enter any cap.
pub fn suggested_delivery_fees() -> Vec<u64> {
    setting(|p| p.suggested_delivery_fees.filter(|fees| !fees.is_empty()), vec![400, 600, 900, 1200])
}

// --- orders ---

/// How long a store has to accept an order once it's placed with it. After
/// that the store can't, and the customer's conductor cancels it -- so a
/// customer never waits on a store that's offline.
pub fn store_response_window() -> Duration {
    Duration::from_secs(setting(|p| p.store_response_secs, 5 * 60))
}

/// The most orders a customer may place within one store response window.
/// Every order is answered or lapses within that window, so this bounds how
/// many a customer can have waiting on stores at once -- an order costs
/// nothing until a store accepts it, so without a bound one identity could
/// bury a store's queue.
pub fn max_pending_orders() -> u32 {
    setting(|p| p.max_pending_orders, 5).max(1)
}

/// What listing a store for customers to find sets aside, in minor units --
/// returned when it closes. A store is a network entry anyone can write, so
/// without a cost one identity could fill a neighbourhood's listings with
/// fakes; with one, every listing is backed by money for as long as it's
/// listed.
pub fn store_listing_stake() -> u64 {
    setting(|p| p.store_listing_stake, 2_000)
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

/// How long a new goodie bag holds a confirmed claim for its customer to
/// order, until the store sets its own.
pub fn default_bag_hold_minutes() -> u16 {
    setting(|p| p.default_bag_hold_minutes, 30).max(1)
}

/// The longest a goodie bag may stay listed.
pub fn goodie_bag_max_lifetime() -> Duration {
    Duration::from_secs(u64::from(setting(|p| p.goodie_bag_max_days, 7)) * 86_400)
}

// --- drivers ---

/// The most orders a driver may carry at once -- picked up and not yet
/// settled. Validation refuses a pickup past it (`ledger_types::InHand`).
pub fn max_concurrent_deliveries() -> u32 {
    setting(|p| p.max_concurrent_deliveries, 3).max(1)
}

/// How far from a driver's remaining drop-offs another order may go and
/// still be offered to them as an add-on while they're delivering.
pub fn add_on_detour_km() -> f64 {
    setting(|p| p.add_on_detour_km, 2.0)
}

/// How long a driver whose bid is accepted has to commit to the order --
/// setting aside their collateral -- before the store's app offers it to
/// another. DoorDash gives a driver about 45 seconds to accept an offer.
pub fn offer_window() -> Duration {
    Duration::from_secs(setting(|p| p.offer_secs, 45))
}

/// How long a driver checked in at the store waits for an order past its
/// ready time before they may call the store late -- for a store that
/// hasn't set its own (`MerchantCatalog::store_wait_minutes`). Late, the
/// driver leaves paid in full by the store, the order goes to another
/// driver, and its customer may cancel for a full refund. DoorDash
/// cancels a restaurant's order at a 15-minute wait.
pub fn store_wait() -> Duration {
    Duration::from_secs(setting(|p| p.store_wait_secs, 15 * 60)).clamp(min_store_wait(), max_store_wait())
}

/// The shortest wait a store may set: drivers aren't sent away the moment
/// a kitchen runs a little behind.
pub fn min_store_wait() -> Duration {
    Duration::from_secs(setting(|p| p.min_store_wait_secs, 5 * 60))
}

/// The longest wait a store may set: a driver is never kept indefinitely.
pub fn max_store_wait() -> Duration {
    Duration::from_secs(setting(|p| p.max_store_wait_secs, 45 * 60)).max(min_store_wait())
}

/// How long an order whose driver left after the store started cooking it
/// stays open to another driver before the store may end it: the customer
/// is refunded and that driver's collateral pays for the food.
pub fn replacement_window() -> Duration {
    Duration::from_secs(setting(|p| p.replacement_window_secs, 15 * 60))
}

/// How many committed drivers may leave an order -- dropping it, or moved on
/// once late. Past it, the order can only be collected or cancelled.
pub fn max_driver_changes() -> u32 {
    setting(|p| p.max_driver_changes, 6).max(1)
}

/// How many bids an order's customer may accept in all, counting offers a
/// driver let lapse without committing -- so an order's history stays
/// bounded, and checking it cheap, however many throwaway drivers bid.
pub fn max_offers_per_order() -> u32 {
    setting(|p| p.max_offers_per_order, 20).max(max_driver_changes())
}

/// How many different stores a driver must have completed deliveries for
/// before their report that a store wouldn't check them in counts on its
/// record -- so a throwaway identity, or a ring of them trading among
/// themselves, can't bury a competitor in reports.
pub fn min_reporter_stores() -> u32 {
    setting(|p| p.min_reporter_stores, 3)
}

/// How many of an order's bids its customer's app weighs, earliest first --
/// so a flood of bids from throwaway drivers can't slow it down.
pub fn max_ranked_bids() -> u32 {
    setting(|p| p.max_ranked_bids, 30).max(1)
}

/// How long a customer's app collects bids, from the first, before matching
/// automatically.
pub fn bid_window() -> Duration {
    Duration::from_secs(setting(|p| p.bid_window_secs, 30))
}

/// What a minute of a driver's arrival time counts for when matching
/// automatically, in minor units -- so a faster driver can win at a higher
/// price. Published with the rest of the matching rule.
pub fn minute_value_cents() -> u64 {
    setting(|p| p.minute_value_cents, 10)
}

/// The public time source -- see `TimeSource`.
pub fn time_source() -> TimeSource {
    setting(
        |p| p.time_source,
        TimeSource {
            public_key: "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a".into(),
            genesis_secs: 1_692_803_367,
            period_secs: 3,
            relays: vec!["https://api.drand.sh".into(), "https://drand.cloudflare.com".into()],
            chain_hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971".into(),
        },
    )
}

// --- handoffs and settlement ---

/// How many wrong handoff codes a giver's conductor answers for one order
/// before it stops: a handful of tries can't find six digits, a million
/// could.
pub fn max_code_attempts() -> u32 {
    setting(|p| p.max_code_attempts, 5)
}

/// How long past the store's ready time (or its confirming the driver, if
/// later) a driver has to check in at the store before they're late: the
/// store's app hands the order to another driver, and its customer may
/// collect it themselves instead. Until then only the driver can drop it.
pub fn pickup_grace() -> Duration {
    Duration::from_secs(setting(|p| p.pickup_grace_secs, 15 * 60))
}

/// How long a customer who chose to collect a delivery themselves has to
/// come for it, before the store may record it uncollected and keep its
/// price -- it cooked the food.
pub fn collection_window() -> Duration {
    Duration::from_secs(setting(|p| p.collection_window_secs, 60 * 60))
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
