//! How an order settles once it's out of the kitchen: the store decides.
//!
//! There's no referee. Two people can't settle conflicting claims without
//! one, so for each order one party writes the single decision every
//! payment then cites, and validation lets it write only one: the store. It
//! has nothing to gain either way -- it's paid for the food by the customer
//! if the order arrived, and by the driver's collateral if it didn't.
//!
//! - `OrderOutcome` (deliveries): where the food went. *Delivered*, citing
//!   the order completed on proof the customer has it -- the driver is then
//!   paid. *Not delivered*, citing the customer's claim after a proven
//!   pickup -- the customer and the store get back what they paid, and the
//!   store takes the driver's collateral for the food.
//! - `ItemSettlement`: what the food's payment comes to. The customer
//!   reports items missing or wrong (`ItemIssue`), the store accepts or
//!   declines each (`IssueResponse`) and has the final say, as it would if
//!   you ordered from it directly; the settlement names the refund.
//!
//! Its app waits out a report window before settling, and refunds what the
//! store accepted or never answered -- a store's own choice, made visible.

use hdi::prelude::*;
use relay_integrity_support::SealedChunks;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueKind {
    /// Not in the bag.
    Missing,
    /// Something else in its place.
    Wrong,
}

/// Some units of one line on the order -- an item with its choices, so a
/// refund is worth what that line cost ("the large latte with oat milk").
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct IssueLine {
    /// The line's position on the order, from 0.
    pub line: u32,
    pub quantity: u32,
    pub kind: IssueKind,
}

/// What a customer can say about an issue, sealed to the store: a note, and
/// a photo.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct IssueEvidence {
    pub note: String,
    /// An inline image, or empty for none.
    pub photo_data_uri: String,
}

/// A customer reporting items missing or wrong on an order they have.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct ItemIssue {
    /// The order's original action.
    pub order: ActionHash,
    /// The version of the order showing the customer has it: its delivered
    /// version, or their own update collecting a pickup.
    pub received: ActionHash,
    pub lines: Vec<IssueLine>,
    /// The customer's `IssueEvidence`, sealed to the store.
    pub sealed_for_store: SealedChunks,
}

/// The store's answer to an `ItemIssue`: accept it (the customer is
/// refunded what it's worth) or decline it (they aren't). One per issue.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct IssueResponse {
    pub issue: ActionHash,
    pub accept: bool,
}

/// Where a delivery's food went, as its store decides -- see the module
/// docs.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// It reached the customer. `proof`: a `Delivered` version of the order.
    Delivered { proof: ActionHash },
    /// It never did. `claim`: the customer's update claiming so, made after
    /// the driver's proven pickup.
    NotDelivered { claim: ActionHash },
}

/// A delivery's outcome, written once by its store.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct OrderOutcome {
    /// The order's original action.
    pub order: ActionHash,
    pub outcome: Outcome,
}

/// What an order's food payment comes to, written once by its store: the
/// customer is refunded `refund` for the `issues` it cites, the store
/// collects the rest.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
// Decodes only from its own fields: a record of another type that
// happens to share these can never pass for this one.
#[serde(deny_unknown_fields)]
pub struct ItemSettlement {
    /// The order's original action.
    pub order: ActionHash,
    /// That the customer has the order: the store's `Delivered` outcome for
    /// a delivery, the customer's own update collecting a pickup.
    pub basis: ActionHash,
    pub issues: Vec<ActionHash>,
    pub refund: u64,
}

/// What `claimed` units of an order's lines are worth, of what the customer
/// paid: each unit at its line's price, scaled by what the order actually
/// cost against its undiscounted subtotal (a promo's discount is shared
/// out), rounded down -- and never more than the order cost. `lines` is the
/// order's (unit price, quantity ordered), in order; `claimed` is (line
/// position, units). A claim for more units of a line than were ordered
/// counts only those ordered.
pub fn claimed_value(lines: &[(u64, u32)], order_total: u64, claimed: &[(u32, u32)]) -> u64 {
    let subtotal: u128 = lines.iter().map(|(price, quantity)| u128::from(*price) * u128::from(*quantity)).sum();
    if subtotal == 0 {
        return 0;
    }
    let claimed_subtotal: u128 = lines
        .iter()
        .enumerate()
        .map(|(position, (price, ordered))| {
            let units: u32 = claimed.iter().filter(|(line, _)| *line as usize == position).map(|(_, q)| *q).sum();
            u128::from(*price) * u128::from(units.min(*ordered))
        })
        .sum();
    let value = claimed_subtotal * u128::from(order_total) / subtotal;
    (value as u64).min(order_total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_claim_is_worth_its_share_of_what_was_paid() {
        let lines = [(500, 2), (1000, 1)];
        assert_eq!(claimed_value(&lines, 2000, &[(0, 1)]), 500, "no promo: the line's price");
        assert_eq!(claimed_value(&lines, 1600, &[(0, 1)]), 400, "a 20% promo shares its discount");
        assert_eq!(claimed_value(&lines, 1600, &[(1, 1), (0, 2)]), 1600, "everything is everything paid");
    }

    #[test]
    fn a_claim_counts_only_what_was_ordered() {
        let lines = [(500, 2)];
        assert_eq!(claimed_value(&lines, 1000, &[(0, 5)]), 1000, "five claimed of two ordered counts two");
        assert_eq!(claimed_value(&lines, 1000, &[(0, 2), (0, 2)]), 1000, "claimed twice still counts two");
        assert_eq!(claimed_value(&lines, 1000, &[(9, 1)]), 0, "a line not on the order is worth nothing");
    }

    #[test]
    fn the_same_item_on_two_lines_is_two_prices() {
        // A plain latte and one with oat milk: the oat milk one is refunded
        // at its own price.
        let lines = [(400, 1), (460, 1)];
        assert_eq!(claimed_value(&lines, 860, &[(1, 1)]), 460);
    }

    #[test]
    fn it_rounds_down() {
        let lines = [(333, 3)];
        assert_eq!(claimed_value(&lines, 999, &[(0, 1)]), 333);
        assert_eq!(claimed_value(&lines, 998, &[(0, 1)]), 332);
    }
}
