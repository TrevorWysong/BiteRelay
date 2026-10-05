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
use relay_coordinator_support::{resolve_latest, resolve_latest_decoded, resolve_links_to_records};

use crate::NearbyMerchantsInput;

/// Keyed on the catalog's *original* creation hash -- same convention as
/// `promo_anchor_path`, and the exact reason `get_my_catalog` was fixed to
/// expose that stable hash separately from its latest-resolved content
/// (see `MyCatalogView`'s own doc comment).
fn bag_anchor_path(catalog_ref: &ActionHash) -> ExternResult<hdi::hash_path::path::TypedPath> {
    Path::from(format!("catalog_bag.{}", catalog_ref)).typed(LinkTypes::CatalogToBag)
}

fn claim_anchor_path(bag_ref: &ActionHash) -> ExternResult<hdi::hash_path::path::TypedPath> {
    Path::from(format!("bag_claim.{}", bag_ref)).typed(LinkTypes::BagToClaim)
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

#[hdk_extern]
pub fn list_goodie_bags_for_catalog(catalog_ref: ActionHash) -> ExternResult<Vec<Record>> {
    let path = bag_anchor_path(&catalog_ref)?;
    let path_hash = match path.path_entry_hash() {
        Ok(hash) => hash,
        Err(_) => return Ok(Vec::new()),
    };
    let links = get_links(LinkQuery::try_new(path_hash, LinkTypes::CatalogToBag)?, GetStrategy::default())?;
    Ok(resolve_links_to_records(links))
}

/// Joins through the *existing* `GeohashToCatalog` anchor rather than a
/// parallel geohash anchor for bags (see `LinkTypes::CatalogToBag`'s own
/// doc comment) -- a bag's location *is* its catalog's location, so this
/// reuses `get_nearby_merchants`'s own cell-and-neighbors walk, then fans
/// out to each returned catalog's own `CatalogToBag` anchor.
#[hdk_extern]
pub fn get_nearby_goodie_bags(input: NearbyMerchantsInput) -> ExternResult<Vec<Record>> {
    let nearby = crate::get_nearby_merchants(input)?;
    let mut bags = Vec::new();
    for catalog_record in nearby.catalogs {
        let catalog_ref = catalog_record.action_address().clone();
        bags.extend(list_goodie_bags_for_catalog(catalog_ref)?);
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

#[hdk_extern]
pub fn get_my_bag_claims(_: ()) -> ExternResult<Vec<Record>> {
    let owner = agent_info()?.agent_initial_pubkey;
    let links = get_links(LinkQuery::try_new(owner, LinkTypes::CustomerToClaim)?, GetStrategy::default())?;
    Ok(resolve_links_to_records(links))
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
    let bags = list_goodie_bags_for_catalog(catalog_ref)?;
    let mut pending = Vec::new();
    for bag_record in bags {
        let bag_ref = bag_record.action_address().clone();
        for claim_record in list_claims_for_bag(bag_ref)? {
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
