//! Escrow: what each hold on an order is for, and who may collect each part
//! of it. One definition, used by the dispatch coordinator to place holds,
//! by the ledger to price and settle them, and by validation on both sides.
//!
//! Money for an order is set aside (held) as soon as the order needs it,
//! by whoever owes it, and moves on only by rules the ledger validates (see
//! `ledger_integrity`):
//!
//! - **Food** -- the customer, when they place the order. The store can't
//!   accept an order without it.
//! - **Driver pay** -- the customer's share of the delivery fee and their
//!   tip, when they accept a driver's bid.
//! - **Subsidy** -- the store's share of the delivery fee, when it confirms
//!   it's preparing a delivery.
//! - **Collateral** -- the driver's, the value of the food, when they pick
//!   it up.
//!
//! Each part of a hold has one recipient, who decides it: they collect it
//! (with proof they're owed it) or waive it back to whoever paid.

use super::{Bid, DeliveryOrder, PickupOrder};
use hdi::prelude::*;

/// What a hold on an order is for. The bid, where there is one, fixes the
/// driver and the fee.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum HoldPurpose {
    Food,
    DriverPay { bid: ActionHash },
    Subsidy { bid: ActionHash },
    Collateral { bid: ActionHash },
}

/// One part of a hold, collected or waived on its own.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Portion {
    /// The food, to the store.
    Food,
    /// A share of the delivery fee, to the driver.
    Fee,
    /// The customer's tip, to the driver.
    Tip,
    /// The driver's collateral: back to the driver once the food is
    /// delivered, to the store if it never was (`OrderOutcome`).
    Collateral,
}

/// A part of a hold: who it's for, and how much.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Share {
    pub portion: Portion,
    pub recipient: AgentPubKey,
    pub amount: u64,
}

/// The terms of an order its holds are priced from -- every one fixed when
/// the order is placed, so the as-created record is the reference.
#[derive(Debug, Clone)]
pub struct OrderTerms {
    pub requester: AgentPubKey,
    pub merchant: AgentPubKey,
    pub order_total: u64,
    pub tip_cents: u64,
    pub delivery_subsidy_percent: u8,
    pub delivery: bool,
}

impl OrderTerms {
    pub fn of_delivery(order: &DeliveryOrder) -> Self {
        Self {
            requester: order.requester.clone(),
            merchant: order.merchant.clone(),
            order_total: order.order_total,
            tip_cents: order.tip_cents,
            delivery_subsidy_percent: order.delivery_subsidy_percent,
            delivery: true,
        }
    }

    pub fn of_pickup(order: &PickupOrder) -> Self {
        Self {
            requester: order.requester.clone(),
            merchant: order.merchant.clone(),
            order_total: order.order_total,
            tip_cents: 0,
            delivery_subsidy_percent: 0,
            delivery: false,
        }
    }
}

/// The store's and the customer's shares of a delivery fee. The store's
/// share rounds down, so the customer's covers any odd cent.
pub fn split_delivery_fee(fee: u64, store_percent: u8) -> (u64, u64) {
    let store = fee * u64::from(store_percent.min(100)) / 100;
    (store, fee - store)
}

/// The collateral a driver must post to deliver `order`: the value of the
/// food they'll be carrying, so a driver who never delivers it has covered
/// what the store handed over.
pub fn required_collateral(order: &DeliveryOrder) -> u64 {
    order.order_total
}

/// Who pays a hold for `purpose` on an order, and its parts -- `None` if the
/// purpose doesn't fit the order (driver pay on a pickup, a bid on another
/// order). Parts of nothing, and parts someone would pay themselves (a
/// customer ordering from their own store), are left out; a hold with no
/// parts is never needed.
pub fn hold_terms(terms: &OrderTerms, purpose: &HoldPurpose, bid: Option<&Bid>) -> Option<(AgentPubKey, Vec<Share>)> {
    let (payer, shares) = match (purpose, bid) {
        (HoldPurpose::Food, None) => (terms.requester.clone(), vec![(Portion::Food, terms.merchant.clone(), terms.order_total)]),
        (HoldPurpose::DriverPay { .. }, Some(bid)) if terms.delivery => {
            let (_, customer_share) = split_delivery_fee(bid.price_offer, terms.delivery_subsidy_percent);
            (terms.requester.clone(), vec![(Portion::Fee, bid.bidder.clone(), customer_share), (Portion::Tip, bid.bidder.clone(), terms.tip_cents)])
        }
        (HoldPurpose::Subsidy { .. }, Some(bid)) if terms.delivery => {
            let (store_share, _) = split_delivery_fee(bid.price_offer, terms.delivery_subsidy_percent);
            (terms.merchant.clone(), vec![(Portion::Fee, bid.bidder.clone(), store_share)])
        }
        (HoldPurpose::Collateral { .. }, Some(bid)) if terms.delivery => (bid.bidder.clone(), vec![(Portion::Collateral, terms.merchant.clone(), bid.collateral)]),
        _ => return None,
    };
    let shares = shares
        .into_iter()
        .filter(|(_, recipient, amount)| *amount > 0 && recipient != &payer)
        .map(|(portion, recipient, amount)| Share { portion, recipient, amount })
        .collect();
    Some((payer, shares))
}

/// What a hold sets aside: the sum of its parts.
pub fn hold_amount(shares: &[Share]) -> u64 {
    shares.iter().map(|share| share.amount).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(n: u8) -> AgentPubKey {
        AgentPubKey::from_raw_36(vec![n; 36])
    }

    fn terms() -> OrderTerms {
        OrderTerms { requester: agent(1), merchant: agent(2), order_total: 2000, tip_cents: 300, delivery_subsidy_percent: 50, delivery: true }
    }

    fn bid(price_offer: u64) -> Bid {
        Bid { order_ref: ActionHash::from_raw_36(vec![9; 36]), bidder: agent(3), eta_seconds: 600, price_offer, collateral: 2000, status: super::super::BidStatus::Open, created_at: Timestamp::from_micros(0) }
    }

    #[test]
    fn the_store_share_rounds_down_and_the_customer_covers_the_rest() {
        assert_eq!(split_delivery_fee(500, 50), (250, 250));
        assert_eq!(split_delivery_fee(501, 50), (250, 251));
        assert_eq!(split_delivery_fee(500, 0), (0, 500));
        assert_eq!(split_delivery_fee(500, 255), (500, 0), "a percent over 100 is treated as 100");
    }

    #[test]
    fn the_food_is_held_for_the_store() {
        let (payer, shares) = hold_terms(&terms(), &HoldPurpose::Food, None).unwrap();
        assert_eq!(payer, agent(1));
        assert_eq!(shares, vec![Share { portion: Portion::Food, recipient: agent(2), amount: 2000 }]);
    }

    #[test]
    fn driver_pay_is_the_customers_fee_share_and_tip() {
        let b = bid(501);
        let (payer, shares) = hold_terms(&terms(), &HoldPurpose::DriverPay { bid: b.order_ref.clone() }, Some(&b)).unwrap();
        assert_eq!(payer, agent(1));
        assert_eq!(hold_amount(&shares), 251 + 300);
        let (store, shares) = hold_terms(&terms(), &HoldPurpose::Subsidy { bid: b.order_ref.clone() }, Some(&b)).unwrap();
        assert_eq!((store, hold_amount(&shares)), (agent(2), 250));
    }

    #[test]
    fn the_collateral_is_the_drivers_held_for_the_store() {
        let b = bid(500);
        let (payer, shares) = hold_terms(&terms(), &HoldPurpose::Collateral { bid: b.order_ref.clone() }, Some(&b)).unwrap();
        assert_eq!(payer, agent(3));
        assert_eq!(shares, vec![Share { portion: Portion::Collateral, recipient: agent(2), amount: 2000 }]);
    }

    #[test]
    fn nothing_is_held_for_yourself_or_for_nothing() {
        let own_store = OrderTerms { merchant: agent(1), ..terms() };
        assert!(hold_terms(&own_store, &HoldPurpose::Food, None).unwrap().1.is_empty());
        let no_tip = OrderTerms { tip_cents: 0, delivery_subsidy_percent: 100, ..terms() };
        let b = bid(500);
        assert!(hold_terms(&no_tip, &HoldPurpose::DriverPay { bid: b.order_ref.clone() }, Some(&b)).unwrap().1.is_empty());
    }

    #[test]
    fn a_purpose_must_fit_the_order() {
        let pickup = OrderTerms { delivery: false, ..terms() };
        let b = bid(500);
        assert!(hold_terms(&pickup, &HoldPurpose::DriverPay { bid: b.order_ref.clone() }, Some(&b)).is_none());
        assert!(hold_terms(&terms(), &HoldPurpose::DriverPay { bid: b.order_ref.clone() }, None).is_none());
    }
}
