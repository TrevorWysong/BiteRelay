//! Goodie-bag claims turned into orders by the customer's own conductor.
//! A claim is a reservation; once the store confirms it, the customer owes
//! the order that redeems it -- authored on their own chain, as every order
//! is. Their conductor writes it (`dispatch::upkeep`), woken by the store's
//! `ClaimConfirmed` signal and swept every minute, so it happens with no app
//! open.
//!
//! Each claim is redeemed at most once: before placing an order the
//! conductor checks its own chain for one already redeeming the claim
//! (`get_my_order_for_claim`), and validation refuses a second redemption
//! outright (`dispatch_integrity::checks::check_bag_claim`), so even two
//! devices racing can't spend a claim twice.

use crate::order_queues::get_my_order_for_claim;
use crate::orders::{request_delivery, RequestDeliveryInput};
use crate::pickup::{request_pickup_order, RequestPickupOrderInput};
use crate::pricing::OrderItem;
use crate::stores::current_catalog;
use catalog_types::{BagClaim, BagClaimFulfillment, BagClaimStatus, GoodieBag};
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, guest, original_action_of, resolve_latest};
use relay_types::GeoPoint;

/// Mirrors `catalog::MyClaim` over the zome-call boundary.
#[derive(Serialize, Deserialize, Debug)]
pub struct MyClaimWire {
    record: Record,
    /// The claim's drop-off, opened (it's stored sealed); `None` for pickup.
    dropoff: Option<GeoPoint>,
}

/// Places the order for every confirmed claim of the caller's that doesn't
/// have one yet. One claim failing (the bag still gossiping, say) doesn't
/// hold up the rest; the next run tries it again.
pub(crate) fn redeem_confirmed_claims() -> ExternResult<()> {
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "catalog", "get_my_bag_claims".into(), None, ())? else {
        return Err(guest("reading your goodie-bag claims failed"));
    };
    let claims: Vec<MyClaimWire> = io.decode().map_err(|e| wasm_error!(e))?;
    for claim in claims {
        relay_coordinator_support::isolated::<_, ()>("redeem_one_claim", claim);
    }
    Ok(())
}

/// Places the order for one confirmed claim -- in a call of its own
/// (`redeem_confirmed_claims`), so one claim that can't be redeemed yet
/// never undoes another's order.
#[hdk_extern]
pub fn redeem_one_claim(mine: MyClaimWire) -> ExternResult<()> {
    redeem(&mine)
}

fn redeem(mine: &MyClaimWire) -> ExternResult<()> {
    let Some(mut claim) = decode_or::<BagClaim>(&mine.record) else { return Ok(()) };
    let mut record = mine.record.clone();
    // The store confirms on its own chain: a claim that still looks pending
    // here is checked for its current version.
    if claim.status != BagClaimStatus::Confirmed {
        record = resolve_latest(original_action_of(record.action_address().clone())?)?;
        match decode_or::<BagClaim>(&record) {
            Some(latest) if latest.status == BagClaimStatus::Confirmed => claim = latest,
            _ => return Ok(()),
        }
    }
    // The confirmation is what an order redeems (validation reads it
    // literally).
    let claim_ref = record.action_address().clone();
    if get_my_order_for_claim(claim_ref.clone())?.is_some() {
        return Ok(());
    }
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "catalog", "get_goodie_bag".into(), None, claim.bag_ref.clone())? else {
        return Err(guest("reading the goodie bag failed"));
    };
    let bag_record: Record = io.decode().map_err(|e| wasm_error!(e))?;
    let bag = decode_or::<GoodieBag>(&bag_record).ok_or(guest("that isn't a goodie bag"))?;
    let store = current_catalog(&bag.catalog_ref)?;
    let merchant = store.owner.clone();
    // The bag's price, and the store's tax on it.
    let order_total = crate::pricing::bag_order_total(&store, bag.price_cents);
    let items = vec![OrderItem { item_ref: claim.bag_ref.clone(), quantity: 1, selections: Vec::new() }];
    let kitchen_notes = format!("Goodie bag: {}", bag.title);
    match claim.fulfillment {
        BagClaimFulfillment::Pickup => {
            request_pickup_order(RequestPickupOrderInput {
                merchant,
                catalog_ref: bag.catalog_ref,
                items,
                order_total,
                kitchen_notes,
                promo_code_ref: None,
                bag_claim_ref: Some(claim_ref),
                age_confirmed: false,
            })?;
        }
        BagClaimFulfillment::Delivery { max_delivery_fee, .. } => {
            let Some(dropoff) = mine.dropoff else {
                return Err(guest("a delivery claim's drop-off couldn't be opened"));
            };
            request_delivery(RequestDeliveryInput {
                merchant,
                catalog_ref: bag.catalog_ref,
                items,
                order_total,
                dropoff,
                max_delivery_fee,
                kitchen_notes,
                dropoff_notes: String::new(),
                tip_cents: 0,
                requested_delivery_time: None,
                promo_code_ref: None,
                dropoff_preference: Default::default(),
                door_risk_accepted: false,
                priority: false,
                // Nobody is at checkout to choose a driver.
                auto_match: true,
                bag_claim_ref: Some(claim_ref),
            })?;
        }
    }
    Ok(())
}

/// Whether the goodie-bag claim an order cites (`claim_ref`, the store's
/// confirmation) has lapsed by the caller's -- the store's -- own clock:
/// its hold ran out before the order could be accepted, and the bag went
/// back on sale. An order's own timestamp is its customer's word, so the
/// store's clock is what counts.
pub(crate) fn bag_hold_lapsed(claim_ref: &ActionHash) -> ExternResult<bool> {
    let confirmation = get(claim_ref.clone(), GetOptions::default())?.ok_or(guest("couldn't read the goodie bag claim"))?;
    let claim: BagClaim = decode_or(&confirmation).ok_or(guest("that isn't a goodie bag claim"))?;
    let bag: GoodieBag = get(claim.bag_ref, GetOptions::default())?.and_then(|r| decode_or(&r)).ok_or(guest("couldn't read the goodie bag"))?;
    Ok(sys_time()? >= bag.claim_lapses_at(confirmation.action().timestamp(), relay_governance::store_response_window()))
}

/// The store accepting an order that redeems a goodie-bag claim: refused
/// if the claim lapsed, and otherwise recorded as sold, in the same commit
/// as the acceptance.
pub(crate) fn redeem_bag_claim(claim_ref: &ActionHash) -> ExternResult<()> {
    if bag_hold_lapsed(claim_ref)? {
        return Err(guest("This goodie bag's hold ran out before the order came in, so it went back on sale. Decline the order."));
    }
    match call(CallTargetCell::Local, "catalog", "redeem_claim".into(), None, claim_ref.clone())? {
        ZomeCallResponse::Ok(_) => Ok(()),
        other => Err(guest(format!("couldn't record the goodie bag as sold: {other:?}"))),
    }
}

