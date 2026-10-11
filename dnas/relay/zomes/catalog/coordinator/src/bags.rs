//! Goodie bags (limited-quantity, time-windowed, discounted mystery bags
//! of surplus food) and the claims against them -- see
//! `GoodieBag`/`BagClaim`'s own doc comments (`catalog_types`)
//! for the scarcity-on-a-DHT design this is built on: a customer creates a
//! `BagClaim` (the `Bid`-shaped half), and the merchant's own client
//! (`confirm_claim`, below) is the single authoritative party that decides
//! who gets one of the limited `quantity_total`, the same shape
//! `dispatch_coordinator::bids::accept_bid` already uses for driver bids.
//!
//! `confirm_claim` deliberately does NOT finish the job: Holochain requires
//! every entry to be authored on its own agent's source chain, so the
//! merchant's call can only flip *this* claim's own status. The customer's
//! own client, seeing their claim turn `Confirmed` (via `recv_remote_signal`
//! below or a plain poll), is the one that calls
//! `dispatch::request_pickup_order`/`request_delivery` with the same
//! `fulfillment` data already captured on the claim -- fully automatic from
//! their side.

use catalog_integrity::*;
use hdi::hash_path::path::Path;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, open, resolve_latest, resolve_latest_decoded, resolve_links_to_records, resolve_links_to_records_with_original, seal};
use relay_types::GeoPoint;

use crate::NearbyMerchantsInput;

/// Keyed on the catalog's *original* creation hash -- same convention as
/// `promo_anchor_path`, and the exact reason `get_my_catalog` was fixed to
/// expose that stable hash separately from its latest-resolved content
/// (see `CatalogView`'s own doc comment).
fn bag_anchor_path(catalog_ref: &ActionHash) -> ExternResult<hdi::hash_path::path::TypedPath> {
    Path::from(bag_path(catalog_ref)).typed(LinkTypes::CatalogToBag)
}

fn claim_anchor_path(bag_ref: &ActionHash) -> ExternResult<hdi::hash_path::path::TypedPath> {
    Path::from(claim_path(bag_ref)).typed(LinkTypes::BagToClaim)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CreateGoodieBagInput {
    pub catalog_ref: ActionHash,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub photo_data_uri: String,
    pub original_value_cents: u64,
    pub price_cents: u64,
    pub quantity_total: u32,
    pub pickup_window_start: Timestamp,
    pub pickup_window_end: Timestamp,
    pub supports_pickup: bool,
    pub supports_delivery: bool,
    pub created_at: Timestamp,
    /// See `GoodieBag::hold_minutes`; the network's default if left out.
    #[serde(default)]
    pub hold_minutes: Option<u16>,
}

#[hdk_extern]
pub fn create_goodie_bag(input: CreateGoodieBagInput) -> ExternResult<Record> {
    let bag = GoodieBag {
        catalog_ref: input.catalog_ref,
        title: input.title,
        description: input.description,
        photo_data_uri: input.photo_data_uri,
        original_value_cents: input.original_value_cents,
        price_cents: input.price_cents,
        quantity_total: input.quantity_total,
        pickup_window_start: input.pickup_window_start,
        pickup_window_end: input.pickup_window_end,
        supports_pickup: input.supports_pickup,
        supports_delivery: input.supports_delivery,
        created_at: input.created_at,
        hold_minutes: input.hold_minutes.unwrap_or_else(relay_governance::default_bag_hold_minutes),
    };
    let catalog_ref = bag.catalog_ref.clone();
    let action_hash = create_entry(&EntryTypes::GoodieBag(bag))?;
    create_link(bag_anchor_path(&catalog_ref)?.path_entry_hash()?, action_hash.clone(), LinkTypes::CatalogToBag, ())?;
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back goodie bag".into())))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateGoodieBagInput {
    pub original_action: ActionHash,
    pub bag: GoodieBag,
}

#[hdk_extern]
pub fn update_goodie_bag(input: UpdateGoodieBagInput) -> ExternResult<Record> {
    let record = resolve_latest(input.original_action)?;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::GoodieBag(input.bag))?;
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back updated goodie bag".into())))
}

#[hdk_extern]
pub fn get_goodie_bag(bag_ref: ActionHash) -> ExternResult<Record> {
    resolve_latest(bag_ref)
}

/// A bag's stable identity (its original action -- what claims reference
/// as `bag_ref`) alongside its latest content. Using the latest record's
/// own action hash as the identity would orphan its claims as soon as the
/// merchant edited it -- the same split `CatalogView` makes.
#[derive(Serialize, Deserialize, Debug)]
pub struct BagView {
    pub original_action: ActionHash,
    pub record: Record,
}

/// Bags listed within the longest a bag may live
/// (`relay_governance::goodie_bag_max_lifetime`) -- the only
/// ones that can still be live (validation caps a bag's lifetime), so this
/// reads a week of links at most, never a store's whole history.
fn recent_bags(catalog_ref: &ActionHash) -> ExternResult<Vec<(BagView, GoodieBag)>> {
    let path_hash = bag_anchor_path(catalog_ref)?.path_entry_hash()?;
    let mut query = LinkQuery::try_new(path_hash, LinkTypes::CatalogToBag)?;
    query.after = Some(Timestamp::from_micros(sys_time()?.as_micros() - bag_lifetime_micros()));
    let links = get_links(query, GetStrategy::default())?;
    Ok(resolve_links_to_records_with_original(links)
        .into_iter()
        .filter_map(|(original_action, record)| {
            let bag = decode_or::<GoodieBag>(&record)?;
            (&bag.catalog_ref == catalog_ref).then_some((BagView { original_action, record }, bag))
        })
        .collect())
}

/// The store's bags that can still be claimed (pickup window not over).
#[hdk_extern]
pub fn list_goodie_bags_for_catalog(catalog_ref: ActionHash) -> ExternResult<Vec<BagView>> {
    let now = sys_time()?;
    Ok(recent_bags(&catalog_ref)?.into_iter().filter(|(_, bag)| bag.pickup_window_end > now).map(|(view, _)| view).collect())
}

#[hdk_extern]
pub fn get_nearby_goodie_bags(input: NearbyMerchantsInput) -> ExternResult<Vec<BagView>> {
    let nearby = crate::get_nearby_merchants(input)?;
    let mut bags = Vec::new();
    for catalog_view in nearby.catalogs {
        bags.extend(list_goodie_bags_for_catalog(catalog_view.original_action)?);
    }
    Ok(bags)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ClaimGoodieBagInput {
    pub bag_ref: ActionHash,
    pub fulfillment: FulfillmentInput,
}

/// How the customer wants the bag, in the clear -- the drop-off is sealed
/// before it's stored (`BagClaimFulfillment::Delivery`).
#[derive(Serialize, Deserialize, Debug)]
pub enum FulfillmentInput {
    Pickup,
    Delivery { dropoff: GeoPoint, max_delivery_fee: Option<u64> },
}

#[hdk_extern]
pub fn claim_goodie_bag(input: ClaimGoodieBagInput) -> ExternResult<Record> {
    let customer = agent_info()?.agent_initial_pubkey;
    // One claim per customer per bag -- validation's rule, told first.
    let mine = query(ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::BagClaim)?).include_entries(true).action_type(ActionType::Create))?;
    if mine.iter().filter_map(decode_or::<BagClaim>).any(|claim| claim.bag_ref == input.bag_ref) {
        return Err(wasm_error!(WasmErrorInner::Guest("You've already claimed this goodie bag.".into())));
    }
    let fulfillment = match input.fulfillment {
        FulfillmentInput::Pickup => BagClaimFulfillment::Pickup,
        FulfillmentInput::Delivery { dropoff, max_delivery_fee } => BagClaimFulfillment::Delivery { sealed_dropoff: seal(&customer, &dropoff)?, max_delivery_fee },
    };
    let claim = BagClaim {
        bag_ref: input.bag_ref.clone(),
        customer,
        fulfillment,
        status: BagClaimStatus::Pending,
        claimed_at: sys_time()?,
    };
    let action_hash = create_entry(&EntryTypes::BagClaim(claim.clone()))?;
    create_link(claim_anchor_path(&input.bag_ref)?.path_entry_hash()?, action_hash.clone(), LinkTypes::BagToClaim, ())?;
    create_link(claim.customer, action_hash.clone(), LinkTypes::CustomerToClaim, ())?;
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back bag claim".into())))
}

#[hdk_extern]
pub fn get_bag_claim(claim_ref: ActionHash) -> ExternResult<Record> {
    resolve_latest(claim_ref)
}

#[hdk_extern]
pub fn list_claims_for_bag(bag_ref: ActionHash) -> ExternResult<Vec<Record>> {
    let path = claim_anchor_path(&bag_ref)?;
    let path_hash = match path.path_entry_hash() {
        Ok(hash) => hash,
        Err(_) => return Ok(Vec::new()),
    };
    let links = get_links(LinkQuery::try_new(path_hash, LinkTypes::BagToClaim)?, GetStrategy::default())?;
    Ok(resolve_links_to_records(links))
}

/// The caller's claims that can still matter -- made within the longest a
/// bag can live, plus a day to finalize. Older claims are history; reading
/// them on every poll (the claim finalizer runs every few seconds) would
/// grow forever.
#[hdk_extern]
pub fn get_my_bag_claims(_: ()) -> ExternResult<Vec<MyClaim>> {
    const FINALIZE_GRACE_MICROS: i64 = 86_400 * 1_000_000;
    let owner = agent_info()?.agent_initial_pubkey;
    let mut query = LinkQuery::try_new(owner.clone(), LinkTypes::CustomerToClaim)?;
    query.after = Some(Timestamp::from_micros(sys_time()?.as_micros() - bag_lifetime_micros() - FINALIZE_GRACE_MICROS));
    let mut claims = Vec::new();
    for record in resolve_links_to_records(get_links(query, GetStrategy::default())?) {
        let dropoff = match decode_or::<BagClaim>(&record).map(|c| c.fulfillment) {
            Some(BagClaimFulfillment::Delivery { sealed_dropoff, .. }) => open(&owner, &sealed_dropoff)?,
            _ => None,
        };
        claims.push(MyClaim { record, dropoff });
    }
    Ok(claims)
}

/// One of the caller's own claims, with a delivery claim's drop-off opened.
#[derive(Serialize, Deserialize, Debug)]
pub struct MyClaim {
    pub record: Record,
    pub dropoff: Option<GeoPoint>,
}

/// Pending claims across *every* bag this merchant owns -- walks this
/// catalog's own `CatalogToBag` anchor, then each bag's `BagToClaim`
/// anchor, same two-hop fan-out `get_nearby_goodie_bags` uses, filtered
/// to `Pending` client-side (no anchor keyed on status -- a claim only
/// ever transitions once, so a dedicated "pending" anchor would save one
/// filter at the cost of a second link to maintain, not worth it at this
/// scale).
#[hdk_extern]
pub fn list_pending_claims_for_merchant(catalog_ref: ActionHash) -> ExternResult<Vec<Record>> {
    // Includes bags whose window just closed: a claim made in time still
    // deserves an answer.
    let mut pending = Vec::new();
    for (bag, _) in recent_bags(&catalog_ref)? {
        for claim_record in list_claims_for_bag(bag.original_action)? {
            if let Ok(Some(claim)) = claim_record.entry().to_app_option::<BagClaim>() {
                if claim.status == BagClaimStatus::Pending {
                    pending.push(claim_record);
                }
            }
        }
    }
    Ok(pending)
}

/// Whether a claim (its latest version) still holds one of its bag's
/// `quantity_total` at `now`: sold, or confirmed and not yet lapsed.
fn holds_a_bag(claim_record: &Record, bag: &GoodieBag, now: Timestamp) -> bool {
    match decode_or::<BagClaim>(claim_record).map(|claim| claim.status) {
        Some(BagClaimStatus::Redeemed) => true,
        Some(BagClaimStatus::Confirmed) => now < bag.claim_lapses_at(claim_record.action().timestamp(), relay_governance::store_response_window()),
        _ => false,
    }
}

/// Confirms a claim -- the merchant-authored half of the two-agent split
/// (see this module's own doc comment) -- if the bag has one left: every
/// sold claim, and every confirmed one still within its hold, counts.
/// Counted on the store's own conductor (validation can't count a bag's
/// claims), and the store is the only one who can confirm, so it can't be
/// skipped; a claim whose hold runs out unordered goes back on sale, and
/// the store refuses an order for it after that (`dispatch` acceptance).
#[hdk_extern]
pub fn confirm_claim(claim_ref: ActionHash) -> ExternResult<Record> {
    let (record, mut claim): (_, BagClaim) = resolve_latest_decoded(claim_ref, "BagClaim")?;
    let (_, bag): (_, GoodieBag) = resolve_latest_decoded(claim.bag_ref.clone(), "GoodieBag")?;

    let now = sys_time()?;
    let taken = list_claims_for_bag(claim.bag_ref.clone())?.iter().filter(|r| holds_a_bag(r, &bag, now)).count() as u32;
    if taken >= bag.quantity_total {
        return Err(wasm_error!(WasmErrorInner::Guest("This bag is sold out.".into())));
    }

    claim.status = BagClaimStatus::Confirmed;
    let customer = claim.customer.clone();
    let updated = update_entry(record.action_address().clone(), &EntryTypes::BagClaim(claim))?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::ClaimConfirmed { claim_hash: updated.clone() }, vec![customer]);
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back confirmed claim".into())))
}

/// The store recording that a confirmed claim was ordered -- called by its
/// acceptance of the order (`dispatch`), so the bag stays sold. Safe to
/// repeat.
#[hdk_extern]
pub fn redeem_claim(claim_ref: ActionHash) -> ExternResult<Record> {
    let (record, mut claim): (_, BagClaim) = resolve_latest_decoded(claim_ref, "BagClaim")?;
    if claim.status == BagClaimStatus::Redeemed {
        return Ok(record);
    }
    claim.status = BagClaimStatus::Redeemed;
    let updated = update_entry(record.action_address().clone(), &EntryTypes::BagClaim(claim))?;
    get(updated, GetOptions::local())?.ok_or(wasm_error!(WasmErrorInner::Guest("could not read back redeemed claim".into())))
}

/// The longest a goodie bag may stay listed, in microseconds.
fn bag_lifetime_micros() -> i64 {
    relay_governance::goodie_bag_max_lifetime().as_micros() as i64
}
