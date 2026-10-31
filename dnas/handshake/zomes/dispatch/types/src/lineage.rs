//! A delivery's history, as validation reads it: each version back to the
//! one it updated, and each party's own updates on their chain.
//!
//! **Why each party's own chain.** An order's history can branch: two
//! parties can each update the same version. Holochain can't say which
//! came first, so a rule that pays money on one branch can't see the
//! other. What validation *can* see is an author's own chain, whole and in
//! order -- so every rule here that could conflict across branches is
//! decided on one chain: a driver can't both leave an order and pick it
//! up, a store can't both move a driver on and check them in, a customer
//! can't both cancel (owing the driver) and take the driver's pay back.

use super::{Beacon, Bid, Cancellation, CollectRequest, DeliveryOrder, DeliveryStatus, PickupOrder};
use hdi::prelude::*;
use handshake_integrity_support::chain::{activity_since, entry_of};

/// Decodes a record's entry as `T`.
fn decode<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(record: &Record) -> Option<T> {
    match record.entry().as_option()? {
        Entry::App(bytes) => T::try_from(SerializedBytes::from(bytes.to_owned())).ok(),
        _ => None,
    }
}

/// One version of a delivery: its record, decoded.
#[derive(Clone)]
pub struct Version {
    pub record: Record,
    pub order: DeliveryOrder,
}

impl Version {
    pub fn of(record: Record) -> Option<Self> {
        decode::<DeliveryOrder>(&record).map(|order| Self { record, order })
    }

    pub fn at(hash: &ActionHash) -> ExternResult<Option<Self>> {
        Ok(Self::of(must_get_valid_record(hash.clone())?))
    }

    /// The version this one updated -- `None` for the order as placed.
    pub fn prior(&self) -> ExternResult<Option<Self>> {
        match &self.record.action().data {
            ActionData::Update(update) => Self::at(&update.original_action_address),
            _ => Ok(None),
        }
    }

    pub fn written_at(&self) -> Timestamp {
        self.record.action().timestamp()
    }

    pub fn author(&self) -> &AgentPubKey {
        self.record.action().author()
    }

    /// The bid this version took the order from -- its driver dropped, or
    /// moved on by the store, before picking it up.
    pub fn released(&self, prior: &Self) -> Option<ActionHash> {
        match (&prior.order.accepted_bid, &self.order.accepted_bid) {
            (Some(bid), None) => Some(bid.clone()),
            _ => None,
        }
    }

    /// The bid this version released, if its driver answers for the food:
    /// they'd committed (their collateral held) and the store had started
    /// cooking it -- and the store hadn't checked them in: a driver who came
    /// for the food never answers for it.
    pub fn released_liable(&self, prior: &Self) -> Option<ActionHash> {
        let answers = prior.order.collateral_hold.is_some() && prior.order.ready_by.is_some() && prior.order.status != DeliveryStatus::DriverAtStore;
        self.released(prior).filter(|_| answers)
    }

    /// The beacon this version carries fresh -- one it set, rather than
    /// carried forward.
    pub fn fresh_beacon<'a>(&'a self, prior: &Self) -> Option<&'a Beacon> {
        self.order.beacon.as_ref().filter(|b| prior.order.beacon.as_ref() != Some(*b))
    }
}

/// When a release happened, for the windows that run from it: a driver
/// leaving dates it with the fresh `beacon` it carries (they'd gain from
/// dating it later), the store with its own record.
pub fn release_time(release: &Version, beacon_time: impl Fn(&Beacon) -> Option<Timestamp>) -> ExternResult<Option<Timestamp>> {
    let prior_beacon = release.prior()?.and_then(|p| p.order.beacon);
    Ok(match &release.order.beacon {
        Some(beacon) if prior_beacon.as_ref() != Some(beacon) => beacon_time(beacon),
        _ => Some(release.written_at()),
    })
}

/// Walks back from `from` (inclusive) to the order as placed, until `found`
/// says stop -- with each version and the one it updated.
pub fn find_back<T>(from: Version, mut found: impl FnMut(&Version, Option<&Version>) -> Option<T>) -> ExternResult<Option<T>> {
    let mut current = from;
    loop {
        let prior = current.prior()?;
        if let Some(hit) = found(&current, prior.as_ref()) {
            return Ok(Some(hit));
        }
        match prior {
            Some(prior) => current = prior,
            None => return Ok(None),
        }
    }
}

/// The order's original action, from any version of it.
pub fn original_of(hash: &ActionHash) -> ExternResult<ActionHash> {
    let mut current = hash.clone();
    loop {
        match must_get_action(current.clone())?.hashed.content.data {
            ActionData::Update(update) => current = update.original_action_address,
            _ => return Ok(current),
        }
    }
}

/// `author`'s updates of `order` (its original action) on their own chain,
/// from `chain_top` back to the order's placement -- newest first.
pub fn updates_by(author: &AgentPubKey, chain_top: &ActionHash, order: &ActionHash) -> ExternResult<Vec<Version>> {
    let placed = must_get_action(order.clone())?.hashed.content.header.timestamp;
    // Which order each version belongs to, as found: a busy store's chain
    // holds many orders' updates, and each is walked back only once.
    let mut belongs: std::collections::HashMap<ActionHash, bool> = std::collections::HashMap::new();
    belongs.insert(order.clone(), true);
    let mut versions = Vec::new();
    for item in activity_since(author, chain_top, placed)? {
        let ActionData::Update(update) = &item.action.hashed.content.data else { continue };
        if !of_order(&update.original_action_address, &mut belongs)? {
            continue;
        }
        versions.extend(Version::at(&item.action.hashed.hash)?);
    }
    Ok(versions)
}

/// A version of an order of either kind, as `wrote_any` hands it over.
// Built once per action walked and dropped -- boxing the large order would
// only add an allocation.
#[allow(clippy::large_enum_variant)]
pub enum AnyVersion {
    Delivery(DeliveryOrder),
    Pickup(PickupOrder),
}

impl AnyVersion {
    /// When the store said it'd be ready: set once it started cooking (a
    /// delivery) or accepted (a pickup).
    pub fn ready_by(&self) -> Option<Timestamp> {
        match self {
            AnyVersion::Delivery(o) => o.ready_by,
            AnyVersion::Pickup(o) => o.ready_by,
        }
    }

    pub fn cancellation(&self) -> Option<&Cancellation> {
        match self {
            AnyVersion::Delivery(o) => o.cancellation.as_ref(),
            AnyVersion::Pickup(o) => o.cancellation.as_ref(),
        }
    }

    /// The driver's bid it has, for a delivery.
    pub fn accepted_bid(&self) -> Option<&ActionHash> {
        match self {
            AnyVersion::Delivery(o) => o.accepted_bid.as_ref(),
            AnyVersion::Pickup(_) => None,
        }
    }
}

/// Whether `author` wrote an update of `order` -- a delivery or a pickup --
/// for which `matches` holds, from `chain_top` back to the order's
/// placement. An order's history can branch, so what someone wrote on one
/// branch still binds them on another: this is how validation sees it.
pub fn wrote_any(author: &AgentPubKey, chain_top: &ActionHash, order: &ActionHash, matches: impl Fn(&AnyVersion) -> bool) -> ExternResult<bool> {
    let placed = must_get_action(order.clone())?.hashed.content.header.timestamp;
    let mut belongs: std::collections::HashMap<ActionHash, bool> = std::collections::HashMap::new();
    belongs.insert(order.clone(), true);
    for item in activity_since(author, chain_top, placed)? {
        let ActionData::Update(update) = &item.action.hashed.content.data else { continue };
        let Entry::App(bytes) = entry_of(&item, &update.entry_hash)? else { continue };
        let bytes = SerializedBytes::from(bytes);
        let version = match DeliveryOrder::try_from(bytes.clone()) {
            Ok(order) => AnyVersion::Delivery(order),
            Err(_) => match PickupOrder::try_from(bytes) {
                Ok(order) => AnyVersion::Pickup(order),
                Err(_) => continue,
            },
        };
        if matches(&version) && of_order(&update.original_action_address, &mut belongs)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether `version` is a version of the order `belongs` was seeded with,
/// remembering the answer for every version walked through.
fn of_order(version: &ActionHash, belongs: &mut std::collections::HashMap<ActionHash, bool>) -> ExternResult<bool> {
    let mut walked = Vec::new();
    let mut current = version.clone();
    let answer = loop {
        if let Some(known) = belongs.get(&current) {
            break *known;
        }
        walked.push(current.clone());
        match must_get_action(current.clone())?.hashed.content.data {
            ActionData::Update(update) => current = update.original_action_address,
            _ => break false,
        }
    };
    for hash in walked {
        belongs.insert(hash, answer);
    }
    Ok(answer)
}

/// Whether `author` wrote an update of `order` for which `matches` holds,
/// given each such version and the one it updated.
pub fn wrote(author: &AgentPubKey, chain_top: &ActionHash, order: &ActionHash, matches: impl Fn(&Version, &Version) -> bool) -> ExternResult<bool> {
    wrote_where(author, chain_top, order, |v, p| Ok(matches(v, p)))
}

/// The same, for a test that reads more of the order's history.
pub fn wrote_where(author: &AgentPubKey, chain_top: &ActionHash, order: &ActionHash, matches: impl Fn(&Version, &Version) -> ExternResult<bool>) -> ExternResult<bool> {
    for version in updates_by(author, chain_top, order)? {
        if let Some(prior) = version.prior()? {
            if matches(&version, &prior)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Whether `version` descends from the version at `ancestor`.
pub fn descends_from(version: &Version, ancestor: &ActionHash) -> ExternResult<bool> {
    Ok(find_back(version.clone(), |v, _| (v.record.action_address() == ancestor).then_some(()))?.is_some())
}

/// Whether `author` asked to collect `order` themselves (`CollectRequest`),
/// between `chain_top` and the order's placement.
pub fn asked_to_collect(author: &AgentPubKey, chain_top: &ActionHash, order: &ActionHash) -> ExternResult<bool> {
    let placed = must_get_action(order.clone())?.hashed.content.header.timestamp;
    for item in activity_since(author, chain_top, placed)? {
        let ActionData::Create(create) = &item.action.hashed.content.data else { continue };
        let Entry::App(bytes) = entry_of(&item, &create.entry_hash)? else { continue };
        if CollectRequest::try_from(SerializedBytes::from(bytes)).is_ok_and(|request| &request.order == order) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether `v` is the store confirming its driver -- starting to cook for
/// them, or confirming them on an order already cooking.
pub fn confirms_driver(v: &Version, prior: &Version) -> bool {
    v.order.status == DeliveryStatus::MerchantConfirmed && prior.order.status == DeliveryStatus::DriverEnRouteToMerchant
}

/// When the driver behind `bid` is due at the store, on the order at
/// `version`: its ready time, or as soon as they could get there from when
/// the store confirmed them, if that's later -- plus the network's grace.
/// `None` before it's cooking.
pub fn due_at_store(version: &Version, bid: &Bid) -> ExternResult<Option<Timestamp>> {
    let Some(ready_by) = version.order.ready_by else { return Ok(None) };
    let bid_ref = version.order.accepted_bid.clone();
    // When the store confirmed this driver -- or, if it hasn't, when they
    // committed.
    let since = find_back(version.clone(), |v, p| {
        let ours = v.order.accepted_bid == bid_ref;
        let confirmed = ours && p.is_some_and(|p| confirms_driver(v, p));
        let committed = ours && v.order.status == DeliveryStatus::DriverEnRouteToMerchant;
        (confirmed || committed).then(|| v.written_at())
    })?
    .unwrap_or(ready_by);
    let arrives = since.as_micros().saturating_add(i64::from(bid.to_store_seconds) * 1_000_000);
    let due = ready_by.as_micros().max(arrives).saturating_add(handshake_governance::pickup_grace().as_micros() as i64);
    Ok(Some(Timestamp::from_micros(due)))
}

/// When the driver accepted at `version` (status `BidAccepted`) must have
/// committed by.
pub fn offer_ends(version: &Version) -> Timestamp {
    Timestamp::from_micros(version.written_at().as_micros().saturating_add(handshake_governance::offer_window().as_micros() as i64))
}

/// The driver who'd answer for the food if `open` -- an order open to bids
/// -- were ended for want of one: the last who left it cooking, with no
/// driver confirmed since. Their release, and their bid.
pub fn liable_release(open: &Version) -> ExternResult<Option<(Version, ActionHash)>> {
    Ok(find_back(open.clone(), |v, p| {
        let p = p?;
        if confirms_driver(v, p) {
            // A later driver was confirmed: whoever left before is clear.
            return Some(None);
        }
        v.released_liable(p).map(|bid| Some((v.clone(), bid)))
    })?
    .flatten())
}

/// How long the store behind `order` may keep a checked-in driver waiting
/// past its ready time, by the terms the order was placed under.
pub fn store_wait(order: &DeliveryOrder) -> ExternResult<core::time::Duration> {
    let record = must_get_valid_record(order.catalog_version.clone())?;
    let minutes = decode::<catalog_types::MerchantCatalog>(&record).and_then(|store| store.store_wait_minutes);
    let wait = minutes.map_or_else(handshake_governance::store_wait, |m| core::time::Duration::from_secs(u64::from(m) * 60));
    Ok(wait.clamp(handshake_governance::min_store_wait(), handshake_governance::max_store_wait()))
}

/// When a driver the store checked in at `at_store` (a `DriverAtStore`
/// version, dated by the store) may call it late: the later of their
/// check-in and the order's ready time, plus the store's wait.
pub fn store_late_after(at_store: &Version) -> ExternResult<Timestamp> {
    let since = at_store.written_at().max(at_store.order.ready_by.unwrap_or(Timestamp(0)));
    Ok(Timestamp::from_micros(since.as_micros().saturating_add(store_wait(&at_store.order)?.as_micros() as i64)))
}

/// Whether `version` is a checked-in driver calling the store late: leaving
/// the order themselves (`prior` names them), from the counter, with fresh
/// proof of a time past the store's wait. They leave paid in full by the
/// store, and the order goes to another driver.
pub fn is_store_late_release(version: &Version, prior: &Version) -> ExternResult<bool> {
    if prior.order.status != DeliveryStatus::DriverAtStore || version.released(prior).is_none() {
        return Ok(false);
    }
    let Some(bid_ref) = &prior.order.accepted_bid else { return Ok(false) };
    let Some(bid) = decode::<Bid>(&must_get_valid_record(bid_ref.clone())?) else { return Ok(false) };
    let Some(beacon) = version.fresh_beacon(prior) else { return Ok(false) };
    if version.author() != &bid.bidder {
        return Ok(false);
    }
    Ok(handshake_integrity_support::beacon::proves_past(Some(beacon), store_late_after(prior)?).is_ok())
}

/// Whether the store has been late on this order: some version back from
/// `from` (inclusive) is a driver calling it late.
pub fn store_was_late(from: &Version) -> ExternResult<bool> {
    let mut current = from.clone();
    loop {
        let Some(prior) = current.prior()? else { return Ok(false) };
        if is_store_late_release(&current, &prior)? {
            return Ok(true);
        }
        current = prior;
    }
}

/// The drivers who've left the order by `from` (inclusive): how many had
/// committed to it, and how many offers there were in all.
pub fn driver_changes(from: &Version) -> ExternResult<DriverChanges> {
    let mut changes = DriverChanges::default();
    let mut current = from.clone();
    while let Some(prior) = current.prior()? {
        if current.released(&prior).is_some() {
            changes.offers += 1;
            if prior.order.collateral_hold.is_some() {
                changes.committed += 1;
            }
        }
        current = prior;
    }
    Ok(changes)
}

/// See `driver_changes`.
#[derive(Debug, Default, Clone, Copy)]
pub struct DriverChanges {
    pub committed: u32,
    pub offers: u32,
}

impl DriverChanges {
    /// Whether the order may take on another driver.
    pub fn allow_another(self) -> bool {
        self.committed < handshake_governance::max_driver_changes() && self.offers < handshake_governance::max_offers_per_order()
    }
}

/// What the store refunds a customer who collected their delivery
/// themselves (`collected`, its Collected version): its share of the last
/// accepted driver's fee, or of the customer's cap if no driver was ever
/// accepted -- what it would have paid toward delivery.
pub fn collection_owed(collected: &Version) -> ExternResult<u64> {
    let (percent, total, cap) = (collected.order.delivery_subsidy_percent, collected.order.order_total, collected.order.max_delivery_fee);
    let fee = match find_back(collected.clone(), |v, _| v.order.accepted_bid.clone())? {
        Some(bid) => decode::<Bid>(&must_get_valid_record(bid)?).map(|b| b.price_offer),
        None => cap,
    };
    Ok(super::collection_compensation(fee, percent, total))
}
