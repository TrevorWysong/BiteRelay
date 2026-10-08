//! Order pricing: what a cart costs and what a promo code takes off it.
//! One definition, used by the dispatch coordinator to price an order and
//! by validation to check it. `web/src/lib/promotions.ts` mirrors these
//! rules for the cart's live preview; both are tested against the same
//! cases.

use super::{PromoRequirement, PromoReward};
use hdi::prelude::*;

/// One line of an order, priced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PricedLine {
    pub item_ref: ActionHash,
    pub unit_price: u64,
    pub quantity: u32,
}

impl PricedLine {
    pub fn total(&self) -> u64 {
        self.unit_price * u64::from(self.quantity)
    }
}

pub fn subtotal(lines: &[PricedLine]) -> u64 {
    lines.iter().map(PricedLine::total).sum()
}

fn line_for<'a>(lines: &'a [PricedLine], item_ref: &ActionHash) -> Option<&'a PricedLine> {
    lines.iter().find(|line| &line.item_ref == item_ref)
}

impl PromoRequirement {
    /// Whether a cart earns the reward. `completed_orders` is how many of
    /// the customer's orders at this store are already complete -- only
    /// `LoyaltyOrderCount` reads it.
    pub fn is_met(&self, lines: &[PricedLine], completed_orders: u32) -> bool {
        match self {
            PromoRequirement::None => true,
            PromoRequirement::MinimumSpend(cents) => subtotal(lines) >= *cents,
            PromoRequirement::MinimumItemQuantity { item_ref, quantity } => line_for(lines, item_ref).is_some_and(|line| line.quantity >= *quantity),
            PromoRequirement::LoyaltyOrderCount(count) => completed_orders >= *count,
        }
    }

    /// How many completed orders this requirement needs shown, if any.
    pub fn completed_orders_needed(&self) -> u32 {
        match self {
            PromoRequirement::LoyaltyOrderCount(count) => *count,
            _ => 0,
        }
    }
}

impl PromoReward {
    /// What the reward takes off the cart, in cents -- never more than the
    /// subtotal. Percentages round down.
    pub fn discount(&self, lines: &[PricedLine]) -> u64 {
        let subtotal = subtotal(lines);
        let off = match self {
            PromoReward::PercentOffSubtotal(percent) => subtotal * u64::from((*percent).min(100)) / 100,
            PromoReward::FlatOffSubtotal(cents) => *cents,
            PromoReward::FreeItem { item_ref, quantity } => line_for(lines, item_ref).map_or(0, |line| u64::from((*quantity).min(line.quantity)) * line.unit_price),
            PromoReward::PercentOffItem { item_ref, percent, quantity } => line_for(lines, item_ref).map_or(0, |line| {
                u64::from((*quantity).min(line.quantity)) * (line.unit_price * u64::from((*percent).min(100)) / 100)
            }),
        };
        off.min(subtotal)
    }
}

/// What a cart costs with an optional promo: the subtotal less the promo's
/// discount -- or `None` if the promo's requirement isn't met.
pub fn order_total(lines: &[PricedLine], promo: Option<(&PromoRequirement, &PromoReward)>, completed_orders: u32) -> Option<u64> {
    let subtotal = subtotal(lines);
    match promo {
        None => Some(subtotal),
        Some((requirement, reward)) => requirement.is_met(lines, completed_orders).then(|| subtotal - reward.discount(lines)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(n: u8) -> ActionHash {
        ActionHash::from_raw_36(vec![n; 36])
    }
    fn line(n: u8, unit_price: u64, quantity: u32) -> PricedLine {
        PricedLine { item_ref: item(n), unit_price, quantity }
    }

    // Each case also runs in web/test/promotions.test.ts -- keep them in step.
    #[test]
    fn percent_off_the_subtotal_rounds_down() {
        let lines = [line(1, 333, 1)];
        assert_eq!(order_total(&lines, Some((&PromoRequirement::None, &PromoReward::PercentOffSubtotal(10))), 0), Some(300));
    }

    #[test]
    fn a_flat_discount_never_exceeds_the_subtotal() {
        let lines = [line(1, 500, 1)];
        assert_eq!(order_total(&lines, Some((&PromoRequirement::None, &PromoReward::FlatOffSubtotal(800))), 0), Some(0));
    }

    #[test]
    fn a_free_item_is_capped_at_what_the_cart_holds() {
        let lines = [line(1, 450, 1), line(2, 1000, 1)];
        let reward = PromoReward::FreeItem { item_ref: item(1), quantity: 2 };
        assert_eq!(order_total(&lines, Some((&PromoRequirement::None, &reward)), 0), Some(1000));
    }

    #[test]
    fn buy_two_get_one_free() {
        let lines = [line(1, 400, 3)];
        let requirement = PromoRequirement::MinimumItemQuantity { item_ref: item(1), quantity: 2 };
        let reward = PromoReward::FreeItem { item_ref: item(1), quantity: 1 };
        assert_eq!(order_total(&lines, Some((&requirement, &reward)), 0), Some(800));
        assert_eq!(order_total(&[line(1, 400, 1)], Some((&requirement, &reward)), 0), None);
    }

    #[test]
    fn percent_off_an_item_rounds_down_per_unit() {
        let lines = [line(1, 999, 2)];
        let reward = PromoReward::PercentOffItem { item_ref: item(1), percent: 50, quantity: 1 };
        assert_eq!(order_total(&lines, Some((&PromoRequirement::None, &reward)), 0), Some(999 * 2 - 499));
    }

    #[test]
    fn minimum_spend_counts_the_whole_cart() {
        let requirement = PromoRequirement::MinimumSpend(2000);
        let reward = PromoReward::FlatOffSubtotal(500);
        assert_eq!(order_total(&[line(1, 1000, 2)], Some((&requirement, &reward)), 0), Some(1500));
        assert_eq!(order_total(&[line(1, 1000, 1)], Some((&requirement, &reward)), 0), None);
    }

    #[test]
    fn loyalty_needs_enough_completed_orders() {
        let requirement = PromoRequirement::LoyaltyOrderCount(5);
        let reward = PromoReward::PercentOffSubtotal(15);
        assert_eq!(order_total(&[line(1, 1000, 1)], Some((&requirement, &reward)), 5), Some(850));
        assert_eq!(order_total(&[line(1, 1000, 1)], Some((&requirement, &reward)), 4), None);
        assert_eq!(requirement.completed_orders_needed(), 5);
    }

    #[test]
    fn no_promo_is_just_the_subtotal() {
        assert_eq!(order_total(&[line(1, 250, 2), line(2, 100, 3)], None, 0), Some(800));
    }
}
