//! Itemized receipts for a customer's completed orders, built from what the
//! network holds rather than what an app remembers: each line at the exact
//! version of its item the order was priced from (the price actually paid),
//! the fee split the order was placed under, and the ledger transactions
//! that paid it -- so a receipt can be checked against the DHT.

use crate::stores::current_catalog;
use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{decode_or, original_action_of, resolve_latest};

#[derive(Serialize, Deserialize, Debug)]
pub struct ReceiptLine {
    /// The item's original action, as the order names it.
    pub item_ref: ActionHash,
    pub name: String,
    pub quantity: u32,
    /// With its choices.
    pub unit_price_cents: u64,
    pub total_cents: u64,
    pub choices: Vec<String>,
}

/// One payment the customer made towards the order -- a part of the money
/// they set aside for it -- and the ledger entry that holds it.
#[derive(Serialize, Deserialize, Debug)]
pub struct ReceiptPayment {
    pub leg: Portion,
    pub amount_cents: u64,
    pub transaction: ActionHash,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Receipt {
    pub order_ref: ActionHash,
    pub delivery: bool,
    pub store_name: String,
    pub store_address: String,
    pub placed_at: Timestamp,
    pub completed_at: Timestamp,
    pub lines: Vec<ReceiptLine>,
    pub subtotal_cents: u64,
    /// A promo's discount: the lines less what the order was priced at.
    pub discount_cents: u64,
    /// The sales tax or VAT in the order, at the store's rates when it was
    /// placed.
    pub tax_cents: u64,
    /// Whether the prices already included it (VAT), rather than having it
    /// added on top.
    pub tax_included: bool,
    /// What the store calls it ("Sales tax", "VAT 20%") -- its first rate's.
    pub tax_label: String,
    /// The store's tax registration, if it gave one.
    pub tax_registration: String,
    /// The customer's share of the driver's fee; 0 for pickup.
    pub delivery_fee_cents: u64,
    pub tip_cents: u64,
    /// What the order cost the customer, all in.
    pub total_cents: u64,
    /// The payments recorded for it (the driver's collateral, held and
    /// returned, isn't a charge and isn't listed).
    pub payments: Vec<ReceiptPayment>,
}

/// The receipt for one of the caller's completed orders.
#[hdk_extern]
pub fn get_order_receipt(order_original_action: ActionHash) -> ExternResult<Receipt> {
    let order_ref = original_action_of(order_original_action)?;
    let record = resolve_latest(order_ref.clone())?;
    let me = agent_info()?.agent_initial_pubkey;
    let (requester, catalog_ref, catalog_version, lines, order_total, tax_cents, delivery_fee, tip, delivery) = if let Some(order) = decode_or::<DeliveryOrder>(&record) {
        if order.status != DeliveryStatus::Delivered {
            return Err(guest("a receipt is for a delivered order"));
        }
        let bid_ref = order.accepted_bid.clone().ok_or(guest("a delivered order has a driver"))?;
        let bid = decode_or::<Bid>(&resolve_latest(bid_ref)?).ok_or(guest("accepted_bid is not a Bid"))?;
        let (_, customer_share) = split_delivery_fee(bid.price_offer, order.delivery_subsidy_percent);
        (order.requester, order.catalog_ref, order.catalog_version, order.lines, order.order_total, order.tax_cents, customer_share, order.tip_cents, true)
    } else if let Some(order) = decode_or::<PickupOrder>(&record) {
        if order.status != PickupStatus::PickedUp {
            return Err(guest("a receipt is for a collected order"));
        }
        (order.requester, order.catalog_ref, order.catalog_version, order.lines, order.order_total, order.tax_cents, 0, 0, false)
    } else {
        return Err(guest("that isn't an order"));
    };
    if requester != me {
        return Err(guest("only the customer has a receipt for an order"));
    }

    let receipt_lines: Vec<ReceiptLine> = crate::lines::describe(&lines)?
        .into_iter()
        .map(|line| ReceiptLine { total_cents: line.unit_price_cents * u64::from(line.quantity), item_ref: line.item_ref, name: line.name, quantity: line.quantity, unit_price_cents: line.unit_price_cents, choices: line.choices })
        .collect();
    let subtotal_cents: u64 = receipt_lines.iter().map(|line| line.total_cents).sum();
    let catalog = current_catalog(&catalog_ref)?;
    let address = [catalog.address_street.as_str(), catalog.address_city.as_str(), catalog.address_state.as_str(), catalog.address_zip.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    let placed_at = get(order_ref.clone(), GetOptions::local())?.map(|r| r.action().timestamp()).unwrap_or(record.action().timestamp());
    // The tax as the store charged it: the version the order was placed under.
    let terms = get(catalog_version, GetOptions::default())?.and_then(|r| decode_or::<catalog_types::MerchantCatalog>(&r)).unwrap_or_else(|| catalog.clone());
    let tax_included = terms.prices_include_tax;
    let food = if tax_included { order_total } else { order_total - tax_cents };

    Ok(Receipt {
        order_ref: order_ref.clone(),
        delivery,
        store_name: catalog.business_name,
        store_address: address,
        placed_at,
        completed_at: record.action().timestamp(),
        lines: receipt_lines,
        subtotal_cents,
        discount_cents: subtotal_cents.saturating_sub(food),
        tax_cents,
        tax_included,
        tax_label: terms.tax_rates.first().map(|r| r.label.clone()).unwrap_or_default(),
        tax_registration: terms.tax_registration.clone(),
        delivery_fee_cents: delivery_fee,
        tip_cents: tip,
        total_cents: order_total + delivery_fee + tip,
        payments: my_payments(&order_ref)?,
    })
}

/// What the caller paid towards the order: each part of the money they set
/// aside for it (the food; a delivery's fee share and tip).
fn my_payments(order_ref: &ActionHash) -> ExternResult<Vec<ReceiptPayment>> {
    let me = agent_info()?.agent_initial_pubkey;
    Ok(crate::settlement::holds_for_order(order_ref)?
        .into_iter()
        .filter(|hold| hold.payer == me)
        .flat_map(|hold| hold.shares.into_iter().map(move |share| ReceiptPayment { leg: share.portion, amount_cents: share.amount, transaction: hold.hold.clone() }))
        .collect())
}

fn guest(message: &str) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message.into()))
}
