//! Order pricing: what a cart costs and what a promo code takes off it.
//! One definition, used by the dispatch coordinator to price an order and
//! by validation to check it. `web/src/lib/menu/promotions.ts` mirrors these
//! rules for the cart's live preview; both are tested against the same
//! cases.

use super::{PromoRequirement, PromoReward, TaxRate};
use hdi::prelude::*;

/// One line of an order, priced. The same item may be on several lines,
/// with different choices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PricedLine {
    pub item_ref: ActionHash,
    /// The item's own price, without its choices -- what an item promo
    /// takes off: a free burger is the burger, its paid extras still
    /// charged, as on DoorDash and Uber Eats.
    pub base_price: u64,
    /// With its choices (`modifiers::line_price`).
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

/// How many units of `item_ref` the cart holds, across its lines.
fn units_of(lines: &[PricedLine], item_ref: &ActionHash) -> u32 {
    lines.iter().filter(|line| &line.item_ref == item_ref).map(|line| line.quantity).sum()
}

/// What `quantity` units of `item_ref` come to at `per_unit` of each line's
/// base price, taking units from the cart's lines in order.
fn off_units(lines: &[PricedLine], item_ref: &ActionHash, quantity: u32, per_unit: impl Fn(u64) -> u64) -> u64 {
    let mut left = quantity;
    let mut off = 0;
    for line in lines.iter().filter(|line| &line.item_ref == item_ref) {
        let units = left.min(line.quantity);
        off += u64::from(units) * per_unit(line.base_price);
        left -= units;
    }
    off
}

impl PromoRequirement {
    /// Whether a cart earns the reward. `completed_orders` is how many of
    /// the customer's orders at this store are already complete -- only
    /// `LoyaltyOrderCount` reads it.
    pub fn is_met(&self, lines: &[PricedLine], completed_orders: u32) -> bool {
        match self {
            PromoRequirement::None => true,
            PromoRequirement::MinimumSpend(cents) => subtotal(lines) >= *cents,
            PromoRequirement::MinimumItemQuantity { item_ref, quantity } => units_of(lines, item_ref) >= *quantity,
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
            PromoReward::FreeItem { item_ref, quantity } => off_units(lines, item_ref, *quantity, |base| base),
            PromoReward::PercentOffItem { item_ref, percent, quantity } => off_units(lines, item_ref, *quantity, |base| base * u64::from((*percent).min(100)) / 100),
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

/// One line of an order as tax sees it: its tax category (an item's, or
/// empty for the store's first rate) and what the line costs before any
/// promo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaxableLine<'a> {
    pub category: &'a str,
    pub total: u64,
}

/// The tax in an order: each category's share of `food_total` (what the
/// food comes to after any promo, which is shared across the lines by what
/// each costs) at the store's rate for it -- an unknown or empty category
/// at the store's first rate -- rounded half up per category. With
/// `included`, prices already contain the tax (VAT), and this is the part
/// of them that's tax; otherwise it's added on top. No rates, no tax.
pub fn order_tax(lines: &[TaxableLine], food_total: u64, rates: &[TaxRate], included: bool) -> u64 {
    let subtotal: u128 = lines.iter().map(|l| u128::from(l.total)).sum();
    let Some(default) = rates.first() else { return 0 };
    if subtotal == 0 {
        return 0;
    }
    let mut categories: Vec<&str> = lines.iter().map(|l| l.category).collect();
    categories.sort_unstable();
    categories.dedup();
    let mut tax: u128 = 0;
    for category in categories {
        let rate = rates.iter().find(|r| r.category == category).unwrap_or(default);
        let bp = u128::from(rate.basis_points);
        let in_category: u128 = lines.iter().filter(|l| l.category == category).map(|l| u128::from(l.total)).sum();
        let taxable = in_category * u128::from(food_total) / subtotal;
        tax += if included {
            let denominator = 10_000 + bp;
            taxable - (taxable * 10_000 + denominator / 2) / denominator
        } else {
            (taxable * bp + 5_000) / 10_000
        };
    }
    tax as u64
}

/// What the customer pays the store: the food after any promo, and the tax
/// on top unless prices include it.
pub fn total_with_tax(food_total: u64, tax: u64, included: bool) -> u64 {
    if included {
        food_total
    } else {
        food_total + tax
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rate(category: &str, basis_points: u16) -> TaxRate {
        TaxRate { category: category.into(), label: String::new(), basis_points }
    }
    fn taxed<'a>(category: &'a str, total: u64) -> TaxableLine<'a> {
        TaxableLine { category, total }
    }

    // The same cases run in web/test/tax.test.ts -- keep them in step.
    #[test]
    fn tax_on_top_rounds_half_up_per_category() {
        let rates = [rate("food", 825)];
        assert_eq!(order_tax(&[taxed("food", 1000)], 1000, &rates, false), 83, "8.25% of $10.00 is 82.5c: 83");
        assert_eq!(order_tax(&[taxed("food", 1000)], 1000, &[], false), 0, "no rates, no tax");
        assert_eq!(total_with_tax(1000, 83, false), 1083);
    }

    #[test]
    fn each_category_at_its_rate_and_unknown_ones_at_the_first() {
        let rates = [rate("prepared", 1000), rate("grocery", 0), rate("alcohol", 2000)];
        let lines = [taxed("prepared", 1000), taxed("grocery", 500), taxed("alcohol", 800), taxed("", 200)];
        // 10% of $10, nothing on groceries, 20% of $8, the first rate on $2.
        assert_eq!(order_tax(&lines, 2500, &rates, false), 280);
    }

    #[test]
    fn a_promo_lowers_the_tax_shared_across_lines() {
        let rates = [rate("prepared", 1000), rate("grocery", 0)];
        // $20 of food, $10 off: each line's taxable share halves.
        let lines = [taxed("prepared", 1000), taxed("grocery", 1000)];
        assert_eq!(order_tax(&lines, 1000, &rates, false), 50);
    }

    #[test]
    fn included_tax_is_the_part_of_the_price_that_is_tax() {
        let rates = [rate("standard", 2000)];
        // £12.00 including 20% VAT: £10.00 net, £2.00 VAT.
        assert_eq!(order_tax(&[taxed("standard", 1200)], 1200, &rates, true), 200);
        assert_eq!(total_with_tax(1200, 200, true), 1200, "the customer pays the price shown");
        // €10.00 at 10%: 9.09 net, 91c tax.
        assert_eq!(order_tax(&[taxed("reduced", 1000)], 1000, &[rate("reduced", 1000)], true), 91);
    }

    fn item(n: u8) -> ActionHash {
        ActionHash::from_raw_36(vec![n; 36])
    }
    fn line(n: u8, unit_price: u64, quantity: u32) -> PricedLine {
        PricedLine { item_ref: item(n), base_price: unit_price, unit_price, quantity }
    }
    fn with_choices(n: u8, base_price: u64, unit_price: u64, quantity: u32) -> PricedLine {
        PricedLine { item_ref: item(n), base_price, unit_price, quantity }
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
    fn an_item_promo_takes_off_the_item_not_its_choices() {
        // A burger at 800 with 200 of extras, twice: one free burger leaves
        // its extras charged.
        let lines = [with_choices(1, 800, 1000, 2)];
        let reward = PromoReward::FreeItem { item_ref: item(1), quantity: 1 };
        assert_eq!(order_total(&lines, Some((&PromoRequirement::None, &reward)), 0), Some(1200));
    }

    #[test]
    fn an_item_on_several_lines_counts_them_all() {
        let lines = [with_choices(1, 400, 400, 1), with_choices(1, 400, 475, 1)];
        let requirement = PromoRequirement::MinimumItemQuantity { item_ref: item(1), quantity: 2 };
        let reward = PromoReward::FreeItem { item_ref: item(1), quantity: 2 };
        assert_eq!(order_total(&lines, Some((&requirement, &reward)), 0), Some(75));
    }

    #[test]
    fn no_promo_is_just_the_subtotal() {
        assert_eq!(order_total(&[line(1, 250, 2), line(2, 100, 3)], None, 0), Some(800));
    }
}
