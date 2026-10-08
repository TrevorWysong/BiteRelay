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
use relay_coordinator_support::{decode_or, resolve_latest, resolve_latest_decoded, resolve_links_to_records, resolve_links_to_records_with_original};

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

#[hdk_extern]
pub fn create_goodie_bag(bag: GoodieBag) -> ExternResult<Record> {
    let catalog_ref = bag.catalog_ref.clone();
    let action_hash = create_entry(&EntryTypes::GoodieBag(bag))?;
    let path = bag_anchor_path(&catalog_ref)?;
    path.ensure()?;
    create_link(path.path_entry_hash()?, action_hash.clone(), LinkTypes::CatalogToBag, ())?;
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

/// Bags listed within the last `MAX_GOODIE_BAG_LIFETIME_MICROS` -- the only
/// ones that can still be live (validation caps a bag's lifetime), so this
/// reads a week of links at most, never a store's whole history.
fn recent_bags(catalog_ref: &ActionHash) -> ExternResult<Vec<(BagView, GoodieBag)>> {
    let path_hash = bag_anchor_path(catalog_ref)?.path_entry_hash()?;
    let mut query = LinkQuery::try_new(path_hash, LinkTypes::CatalogToBag)?;
    query.after = Some(Timestamp::from_micros(sys_time()?.as_micros() - MAX_GOODIE_BAG_LIFETIME_MICROS));
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
    pub fulfillment: BagClaimFulfillment,
}

#[hdk_extern]
pub fn claim_goodie_bag(input: ClaimGoodieBagInput) -> ExternResult<Record> {
    let claim = BagClaim {
        bag_ref: input.bag_ref.clone(),
        customer: agent_info()?.agent_initial_pubkey,
        fulfillment: input.fulfillment,
        status: BagClaimStatus::Pending,
        claimed_at: sys_time()?,
    };
    let action_hash = create_entry(&EntryTypes::BagClaim(claim.clone()))?;
    let path = claim_anchor_path(&input.bag_ref)?;
    path.ensure()?;
    create_link(path.path_entry_hash()?, action_hash.clone(), LinkTypes::BagToClaim, ())?;
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
pub fn get_my_bag_claims(_: ()) -> ExternResult<Vec<Record>> {
    const FINALIZE_GRACE_MICROS: i64 = 86_400 * 1_000_000;
    let owner = agent_info()?.agent_initial_pubkey;
    let mut query = LinkQuery::try_new(owner, LinkTypes::CustomerToClaim)?;
    query.after = Some(Timestamp::from_micros(sys_time()?.as_micros() - MAX_GOODIE_BAG_LIFETIME_MICROS - FINALIZE_GRACE_MICROS));
    Ok(resolve_links_to_records(get_links(query, GetStrategy::default())?))
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

/// Confirms a claim -- the merchant-authored half of the two-agent split
/// (see this module's own doc comment). Re-derives the current `Confirmed`
/// count for this bag via a `get_links` walk and refuses past
/// `quantity_total`: coordinator-level trust, not independently
/// re-verifiable inside deterministic `validate()` (the same honestly-named
/// tier as `order_total`'s own arithmetic -- see `validate_claim_confirmation`'s
/// own doc comment for why that check isn't duplicated there).
#[hdk_extern]
pub fn confirm_claim(claim_ref: ActionHash) -> ExternResult<Record> {
    let (record, mut claim): (_, BagClaim) = resolve_latest_decoded(claim_ref, "BagClaim")?;
    let (_, bag): (_, GoodieBag) = resolve_latest_decoded(claim.bag_ref.clone(), "GoodieBag")?;

    let confirmed_count = list_claims_for_bag(claim.bag_ref.clone())?
        .iter()
        .filter(|r| {
            matches!(
                r.entry().to_app_option::<BagClaim>(),
                Ok(Some(c)) if c.status == BagClaimStatus::Confirmed
            )
        })
        .count() as u32;
    if confirmed_count >= bag.quantity_total {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "this bag's quantity_total has already been fully claimed".into()
        )));
    }

    claim.status = BagClaimStatus::Confirmed;
    let customer = claim.customer.clone();
    let updated = update_entry(record.action_address().clone(), &EntryTypes::BagClaim(claim))?;
    let _ = send_remote_signal(crate::signals::RemoteSignal::ClaimConfirmed { claim_hash: updated.clone() }, vec![customer]);
    get(updated, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back confirmed claim".into())))
}
