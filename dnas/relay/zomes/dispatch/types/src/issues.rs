//! Missing and wrong items, after a customer has their order.
//!
//! Once a delivery or pickup is confirmed, the driver is paid at once (the
//! contents of a sealed bag aren't theirs to answer for), but the store's
//! payment for the food waits out an issue window (`relay_governance::
//! issue_window`). Within it, the customer can report items missing or
//! wrong (`ItemIssue`); the store accepts or declines each report
//! (`IssueResponse`), and has the final say, as it would ordering from it
//! directly. Holding the payment is what makes it answer: a report it
//! never answers is refunded. The window is kept by the order's closing
//! arbitrator -- on its own clock, since a party's timestamps are its own
//! to choose -- which opens it when it sees the order confirmed
//! (`IssueWindowOpened`) and closes it once the window has passed
//! (`IssueWindowClosed`), naming the refund: what the store accepted or
//! let stand. The store then collects the food less the refund, and the
//! customer the refund -- and neither can collect the food any other way
//! once the order is confirmed.

use hdi::prelude::*;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueKind {
    /// Not in the bag.
    Missing,
    /// Something else in its place.
    Wrong,
}

/// Some units of one item on the order.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct IssueLine {
    /// The item's original action, as the order's line names it.
    pub item_ref: ActionHash,
    pub quantity: u32,
    pub kind: IssueKind,
}

/// What a customer can say about an issue, sealed to the store and the
/// arbitrators: a note, and a photo.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct IssueEvidence {
    pub note: String,
    /// An inline image, or empty for none.
    pub photo_data_uri: String,
}

/// A customer reporting items missing or wrong on an order they have.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct ItemIssue {
    /// The order's original action.
    pub order: ActionHash,
    pub lines: Vec<IssueLine>,
    /// The customer's `IssueEvidence`, sealed to the store.
    pub sealed_for_store: XSalsa20Poly1305EncryptedData,
    /// The same, sealed to each arbitrator.
    pub sealed_for_arbitrators: Vec<dispute_types::ArbitratorSeal>,
}

/// The store's answer to an `ItemIssue`: accept it (the customer is
/// refunded what it's worth when the window closes), or decline it (they
/// aren't). One per issue. A store that says nothing by the close has let
/// it stand.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct IssueResponse {
    pub issue: ActionHash,
    pub accept: bool,
}

/// The order's closing arbitrator seeing it confirmed: the issue window
/// runs from this action's own timestamp.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct IssueWindowOpened {
    /// The order's original action.
    pub order: ActionHash,
    /// What confirmed it: the customer's receipt, a scanned handover, the
    /// customer collecting a pickup, or a ruling that it was delivered.
    pub confirmation: ActionHash,
}

/// The order's closing arbitrator closing its issue window, no sooner than
/// the window after it opened: the refund owed for the issues reported
/// before it closed.
#[hdk_entry_helper]
#[derive(Clone, PartialEq, Eq)]
pub struct IssueWindowClosed {
    pub opened: ActionHash,
    /// Every issue the refund accounts for.
    pub issues: Vec<ActionHash>,
    /// Owed to the customer, from the food's held payment; the store
    /// collects the rest.
    pub refund: u64,
}

/// What `claimed` units of an order's items are worth, of what the customer
/// paid: each unit at its line's price, scaled by what the order actually
/// cost against its undiscounted subtotal (a promo's discount is shared
/// out), rounded down -- and never more than the order cost. `lines` is the
/// order's (item, unit price, quantity ordered); a claim for more units of
/// an item than were ordered counts only those ordered.
pub fn claimed_value(lines: &[(ActionHash, u64, u32)], order_total: u64, claimed: &[(ActionHash, u32)]) -> u64 {
    let subtotal: u128 = lines.iter().map(|(_, price, quantity)| u128::from(*price) * u128::from(*quantity)).sum();
    if subtotal == 0 {
        return 0;
    }
    let claimed_subtotal: u128 = lines
        .iter()
        .map(|(item, price, ordered)| {
            let units: u32 = claimed.iter().filter(|(c, _)| c == item).map(|(_, q)| *q).sum();
            u128::from(*price) * u128::from(units.min(*ordered))
        })
        .sum();
    let value = claimed_subtotal * u128::from(order_total) / subtotal;
    (value as u64).min(order_total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(n: u8) -> ActionHash {
        ActionHash::from_raw_36(vec![n; 36])
    }

    #[test]
    fn a_claim_is_worth_its_share_of_what_was_paid() {
        let lines = [(item(1), 500, 2), (item(2), 1000, 1)];
        assert_eq!(claimed_value(&lines, 2000, &[(item(1), 1)]), 500, "no promo: the item's price");
        assert_eq!(claimed_value(&lines, 1600, &[(item(1), 1)]), 400, "a 20% promo shares its discount");
        assert_eq!(claimed_value(&lines, 1600, &[(item(2), 1), (item(1), 2)]), 1600, "everything is everything paid");
    }

    #[test]
    fn a_claim_counts_only_what_was_ordered() {
        let lines = [(item(1), 500, 2)];
        assert_eq!(claimed_value(&lines, 1000, &[(item(1), 5)]), 1000, "five claimed of two ordered counts two");
        assert_eq!(claimed_value(&lines, 1000, &[(item(1), 2), (item(1), 2)]), 1000, "claimed twice still counts two");
        assert_eq!(claimed_value(&lines, 1000, &[(item(9), 1)]), 0, "an item not on the order is worth nothing");
    }

    #[test]
    fn it_rounds_down() {
        let lines = [(item(1), 333, 3)];
        assert_eq!(claimed_value(&lines, 999, &[(item(1), 1)]), 333);
        assert_eq!(claimed_value(&lines, 998, &[(item(1), 1)]), 332);
    }
}
