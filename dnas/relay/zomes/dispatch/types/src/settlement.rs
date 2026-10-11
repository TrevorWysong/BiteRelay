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
//! - **Collateral** -- the driver's, the value of the food, when they
//!   commit to the order -- before the store starts cooking it, so a driver
//!   who leaves it cooked and uncollected has covered it.
//! - **Subsidy** -- the store's, when it checks the driver in: its share of
//!   the delivery fee, and the customer's share again (`LateCover`), paid
//!   to the driver only if the store then keeps them waiting.
//!
//! Each part of a hold has one recipient, who decides it: they collect it
//! (with proof they're owed it) or waive it back to whoever paid -- except
//! where a decision only one chain can make returns it (see
//! `ledger_integrity`).

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
    /// delivered, to the store if it never was (`OrderOutcome`), or if they
    /// left it cooked and no other driver came (`Cancellation::NoDriver`).
    Collateral,
    /// The customer's share of the fee, from the store: the driver's if the
    /// store keeps them waiting (`Cancellation::StoreLate`) -- the customer
    /// is refunded, and the driver is still paid in full -- the store's
    /// again otherwise.
    LateCover,
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
    /// A delivery whose driver carries nothing else.
    pub priority: bool,
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
            priority: order.priority,
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
            priority: false,
        }
    }
}

/// The store's and the customer's shares of a delivery fee. The store's
/// share rounds down, so the customer's covers any odd cent.
pub fn split_delivery_fee(fee: u64, store_percent: u8) -> (u64, u64) {
    let store = fee * u64::from(store_percent.min(100)) / 100;
    (store, fee - store)
}

/// What a customer who collects a delivery themselves is refunded of the
/// food's price: the store's share of the fee it would have paid a driver
/// -- `fee`, the last driver's accepted bid, or the customer's cap if no
/// driver was ever accepted -- so the store pays the same either way. Never
/// more than the food cost.
pub fn collection_compensation(fee: Option<u64>, store_percent: u8, order_total: u64) -> u64 {
    fee.map_or(0, |fee| split_delivery_fee(fee, store_percent).0).min(order_total)
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
            let (store_share, customer_share) = split_delivery_fee(bid.price_offer, terms.delivery_subsidy_percent);
            (terms.merchant.clone(), vec![(Portion::Fee, bid.bidder.clone(), store_share), (Portion::LateCover, bid.bidder.clone(), customer_share)])
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

    #[test]
    fn a_driver_carries_up_to_the_limit_and_frees_a_place_as_each_settles() {
        let mut hands = InHand::default();
        for _ in 0..3 {
            hands = hands.taking(false, 3).unwrap();
        }
        assert_eq!(hands.taking(false, 3), Err(CarryRefusal::AtLimit));
        hands = hands.settling().unwrap();
        assert_eq!(hands.taking(false, 3).map(|h| h.orders), Ok(3));
    }

    #[test]
    fn a_priority_order_goes_alone() {
        let one = InHand::default().taking(false, 3).unwrap();
        assert_eq!(one.taking(true, 3), Err(CarryRefusal::PriorityGoesAlone));
        let priority = InHand::default().taking(true, 3).unwrap();
        assert_eq!(priority.taking(false, 3), Err(CarryRefusal::CarryingPriority));
        assert_eq!(priority.settling(), Some(InHand::default()), "delivering it frees the driver entirely");
    }

    #[test]
    fn nothing_settles_from_empty_hands() {
        assert_eq!(InHand::default().settling(), None);
    }

    fn agent(n: u8) -> AgentPubKey {
        AgentPubKey::from_raw_36(vec![n; 36])
    }

    fn terms() -> OrderTerms {
        OrderTerms { requester: agent(1), merchant: agent(2), order_total: 2000, tip_cents: 300, delivery_subsidy_percent: 50, delivery: true, priority: false }
    }

    fn bid(price_offer: u64) -> Bid {
        Bid { order_ref: ActionHash::from_raw_36(vec![9; 36]), bidder: agent(3), eta_seconds: 600, to_store_seconds: 300, price_offer, collateral: 2000, status: super::super::BidStatus::Open, created_at: Timestamp::from_micros(0) }
    }

    #[test]
    fn a_collecting_customer_gets_the_stores_share_of_the_fee() {
        assert_eq!(collection_compensation(Some(500), 50, 2000), 250);
        assert_eq!(collection_compensation(None, 50, 2000), 0, "no fee to share");
        assert_eq!(collection_compensation(Some(5000), 100, 2000), 2000, "never more than the food");
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
        assert_eq!(store, agent(2));
        assert_eq!(
            shares,
            vec![Share { portion: Portion::Fee, recipient: agent(3), amount: 250 }, Share { portion: Portion::LateCover, recipient: agent(3), amount: 251 }],
            "the store's share, and the customer's again in case it keeps the driver waiting"
        );
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

/// The orders a driver has in hand: those whose collateral they've set
/// aside (by committing to them) and not yet had back or forfeited. The ledger
/// carries it from entry to entry like the balance (`ledger_types`), so
/// validation checks it in one step rather than walking the chain; a
/// customer's app counts a driver's assigned orders the same way before
/// accepting their bid.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct InHand {
    pub orders: u32,
    /// Whether the one order in hand is a priority order, which goes alone.
    pub priority: bool,
}

/// Why a driver can't take one more order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CarryRefusal {
    /// They're carrying a priority order, which goes alone.
    CarryingPriority,
    /// The new order is a priority order, and they're carrying others.
    PriorityGoesAlone,
    /// They're carrying as many orders as the network allows.
    AtLimit,
}

impl CarryRefusal {
    /// The rule, as validation states it.
    pub fn rule(self) -> &'static str {
        match self {
            CarryRefusal::CarryingPriority => "a priority order is carried alone",
            CarryRefusal::PriorityGoesAlone => "a priority order is picked up with nothing else in hand",
            CarryRefusal::AtLimit => "a driver may carry no more orders at once than the network allows",
        }
    }
}

impl InHand {
    /// After taking one more order (a priority one, if `priority`), with at
    /// most `max` in hand.
    pub fn taking(self, priority: bool, max: u32) -> Result<Self, CarryRefusal> {
        if self.priority {
            return Err(CarryRefusal::CarryingPriority);
        }
        if priority && self.orders > 0 {
            return Err(CarryRefusal::PriorityGoesAlone);
        }
        if self.orders >= max {
            return Err(CarryRefusal::AtLimit);
        }
        Ok(Self { orders: self.orders + 1, priority })
    }

    /// After one order in hand is settled: delivered (the driver's collateral
    /// back) or not (forfeited). `None` if none was in hand.
    pub fn settling(self) -> Option<Self> {
        // A priority order is the only one in hand, so settling it leaves none.
        self.orders.checked_sub(1).map(|orders| Self { orders, priority: false })
    }
}
