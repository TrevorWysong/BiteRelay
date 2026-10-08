//! Prices a new order exactly the way validation will check it
//! (`dispatch_integrity::checks::check_pricing`): each item at its latest
//! version, any promo applied with the shared `catalog_types` pricing. The
//! client says what total it showed the customer; if prices have moved since,
//! the order is refused with the new total rather than charged silently.

use crate::order_queues::my_completions_at;
use catalog_types::{order_total, BagClaim, GoodieBag, MenuItem, PricedLine, PromoCode};
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::resolve_latest_fresh;

/// One thing to order, and how many.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OrderItemInput {
    pub item_ref: ActionHash,
    pub quantity: u32,
}

pub(crate) struct PricedOrder {
    pub lines: Vec<OrderLine>,
    pub order_total: u64,
    pub loyalty_proof: Vec<ActionHash>,
}

/// Prices an order at `catalog_ref`. A goodie-bag order (`bag_claim_ref`)
/// is the claimed bag at its own price; anything else is priced from the
/// menu. Fails if an item isn't on this store's menu or is sold out, if a
/// promo's requirement isn't met, or if the total isn't `expected_total`.
pub(crate) fn price_order(catalog_ref: &ActionHash, items: &[OrderItemInput], promo_ref: Option<&ActionHash>, bag_claim_ref: Option<&ActionHash>, expected_total: u64) -> ExternResult<PricedOrder> {
    let priced = match bag_claim_ref {
        Some(claim_ref) => price_bag_order(catalog_ref, claim_ref, promo_ref)?,
        None => price_menu_order(catalog_ref, items, promo_ref)?,
    };
    if priced.order_total != expected_total {
        return Err(guest(format!(
            "prices have changed since this was added to your cart: the total is now {} cents, not {expected_total}",
            priced.order_total
        )));
    }
    Ok(priced)
}

fn price_bag_order(catalog_ref: &ActionHash, claim_ref: &ActionHash, promo_ref: Option<&ActionHash>) -> ExternResult<PricedOrder> {
    if promo_ref.is_some() {
        return Err(guest("a goodie bag can't be combined with a promo code".into()));
    }
    let claim: BagClaim = decode_latest(claim_ref, "BagClaim")?;
    let bag: GoodieBag = decode_latest(&claim.bag_ref, "GoodieBag")?;
    if &bag.catalog_ref != catalog_ref {
        return Err(guest("that goodie bag isn't from this store".into()));
    }
    Ok(PricedOrder {
        lines: vec![OrderLine { item_ref: claim.bag_ref.clone(), priced_version: claim.bag_ref, quantity: 1 }],
        order_total: bag.price_cents,
        loyalty_proof: Vec::new(),
    })
}

fn price_menu_order(catalog_ref: &ActionHash, items: &[OrderItemInput], promo_ref: Option<&ActionHash>) -> ExternResult<PricedOrder> {
    // One line per item, however the client listed them.
    let mut quantities: Vec<(ActionHash, u32)> = Vec::new();
    for item in items {
        match quantities.iter_mut().find(|(item_ref, _)| item_ref == &item.item_ref) {
            Some((_, quantity)) => *quantity += item.quantity,
            None => quantities.push((item.item_ref.clone(), item.quantity)),
        }
    }
    let mut lines = Vec::with_capacity(quantities.len());
    let mut priced = Vec::with_capacity(quantities.len());
    for (item_ref, quantity) in quantities {
        let record = resolve_latest_fresh(item_ref.clone())?;
        let item: MenuItem = record.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("that isn't a menu item".into()))?;
        if &item.catalog_ref != catalog_ref {
            return Err(guest(format!("{} isn't on this store's menu", item.name)));
        }
        if !item.available {
            return Err(guest(format!("{} is sold out", item.name)));
        }
        lines.push(OrderLine { item_ref: item_ref.clone(), priced_version: record.action_address().clone(), quantity });
        priced.push(PricedLine { item_ref, unit_price: item.price_cents, quantity });
    }

    let promo = match promo_ref {
        Some(promo_ref) => Some(decode_latest::<PromoCode>(promo_ref, "PromoCode")?),
        None => None,
    };
    let needed = promo.as_ref().map_or(0, |p| p.requirement.completed_orders_needed()) as usize;
    let loyalty_proof: Vec<ActionHash> = if needed > 0 { my_completions_at(catalog_ref)?.into_iter().take(needed).collect() } else { Vec::new() };
    let total = order_total(&priced, promo.as_ref().map(|p| (&p.requirement, &p.reward)), loyalty_proof.len() as u32)
        .ok_or(guest("this order doesn't meet the promo code's requirement".into()))?;
    Ok(PricedOrder { lines, order_total: total, loyalty_proof })
}

/// An entry at its current state, from the network.
fn decode_latest<T: TryFrom<SerializedBytes, Error = SerializedBytesError>>(action_hash: &ActionHash, type_name: &str) -> ExternResult<T> {
    resolve_latest_fresh(action_hash.clone())?
        .entry()
        .to_app_option::<T>()
        .map_err(|e| wasm_error!(e))?
        .ok_or(guest(format!("that isn't a {type_name}")))
}

fn guest(message: String) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message))
}
