//! What a completed order owes, and to whom -- the one definition both
//! sides use: the dispatch coordinator pays these legs, and ledger
//! validation accepts a payment only if it's exactly one of them.

use super::{Bid, DeliveryOrder, PickupOrder};
use hdi::prelude::*;

/// One part of settling a completed order. Each is paid by its own payer
/// (see `ledger_integrity`), so each is a separate transaction.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaymentLeg {
    /// The customer pays the store for the food.
    OrderTotal,
    /// The customer's share of the driver's delivery fee.
    DeliveryFeeCustomerShare,
    /// The store's share of the driver's delivery fee
    /// (`DeliveryOrder::delivery_subsidy_percent`).
    DeliveryFeeStoreShare,
    /// The customer's tip, all of it to the driver.
    Tip,
    /// The driver's collateral, held by the customer since pickup
    /// (`DeliveryOrder::collateral_hold`), handed back on delivery.
    CollateralReturn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegPayment {
    pub leg: PaymentLeg,
    pub from: AgentPubKey,
    pub to: AgentPubKey,
    pub amount: u64,
}

/// The store's and the customer's shares of a delivery fee. The store's
/// share rounds down, so the customer's covers any odd cent.
pub fn split_delivery_fee(fee: u64, store_percent: u8) -> (u64, u64) {
    let store = fee * u64::from(store_percent.min(100)) / 100;
    (store, fee - store)
}

/// Everything a delivered order owes, given its accepted bid. Legs of zero,
/// and legs from an agent to themselves (a customer ordering from their own
/// store), are left out -- there's nothing to pay.
pub fn delivery_payments(order: &DeliveryOrder, bid: &Bid) -> Vec<LegPayment> {
    let (store_share, customer_share) = split_delivery_fee(bid.price_offer, order.delivery_subsidy_percent);
    let collateral = if order.collateral_hold.is_some() { bid.collateral } else { 0 };
    owed([
        (PaymentLeg::OrderTotal, &order.requester, &order.merchant, order.order_total),
        (PaymentLeg::DeliveryFeeCustomerShare, &order.requester, &bid.bidder, customer_share),
        (PaymentLeg::DeliveryFeeStoreShare, &order.merchant, &bid.bidder, store_share),
        (PaymentLeg::Tip, &order.requester, &bid.bidder, order.tip_cents),
        (PaymentLeg::CollateralReturn, &order.requester, &bid.bidder, collateral),
    ])
}

/// The collateral a driver must post to deliver `order`: the value of the
/// food they'll be carrying, so a driver who never delivers it has covered
/// what the customer paid for.
pub fn required_collateral(order: &DeliveryOrder) -> u64 {
    order.order_total
}

/// Everything a picked-up order owes: just the food.
pub fn pickup_payments(order: &PickupOrder) -> Vec<LegPayment> {
    owed([(PaymentLeg::OrderTotal, &order.requester, &order.merchant, order.order_total)])
}

fn owed<const N: usize>(legs: [(PaymentLeg, &AgentPubKey, &AgentPubKey, u64); N]) -> Vec<LegPayment> {
    legs.into_iter()
        .filter(|(_, from, to, amount)| *amount > 0 && from != to)
        .map(|(leg, from, to, amount)| LegPayment { leg, from: from.clone(), to: to.clone(), amount })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_store_share_rounds_down_and_the_customer_covers_the_rest() {
        assert_eq!(split_delivery_fee(500, 50), (250, 250));
        assert_eq!(split_delivery_fee(501, 50), (250, 251));
        assert_eq!(split_delivery_fee(500, 0), (0, 500));
        assert_eq!(split_delivery_fee(500, 100), (500, 0));
    }

    #[test]
    fn a_percent_over_100_is_treated_as_100() {
        assert_eq!(split_delivery_fee(500, 255), (500, 0));
    }
}
