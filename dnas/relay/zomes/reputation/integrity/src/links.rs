//! Link validation. Every read in this zome (ratings, summaries, review
//! lists) trusts that a link under a base points at an entry *about* that
//! base. Without these rules a peer could, e.g., link genuine one-star
//! reviews of other stores under a competitor's store and drag its rating
//! down -- every entry would still be valid, only the links would lie.

use crate::*;
use relay_integrity_support::{decode, invalid, link_target, original_creation, require, LinkTarget};

/// The link type an entry about `target` must be indexed under, and the
/// base it must hang off.
fn event_link(target: &ReputationTarget) -> (LinkTypes, LinkTypes, AnyLinkableHash) {
    match target {
        ReputationTarget::Store(c) => (LinkTypes::StoreToEvent, LinkTypes::StoreToReputationCheckpoint, c.clone().into()),
        ReputationTarget::Driver(a) => (LinkTypes::DriverToEvent, LinkTypes::DriverToReputationCheckpoint, a.clone().into()),
        ReputationTarget::Customer(a) => (LinkTypes::CustomerToEvent, LinkTypes::CustomerToReputationCheckpoint, a.clone().into()),
    }
}

fn review_link(target: &ReviewTarget) -> (LinkTypes, LinkTypes, AnyLinkableHash) {
    match target {
        ReviewTarget::Store(c) => (LinkTypes::StoreToReview, LinkTypes::StoreToRatingCheckpoint, c.clone().into()),
        ReviewTarget::Driver(a) => (LinkTypes::DriverToReview, LinkTypes::DriverToRatingCheckpoint, a.clone().into()),
    }
}

/// A data link is valid only if its type and base match what the target
/// entry says it's about, and it's authored by that entry's own author.
pub fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let LinkTarget::Record(record) = link_target(target)? else {
        return invalid("reputation links must target a record");
    };
    if record.action().author() != author {
        return invalid("a reputation link must be authored by the author of the entry it indexes");
    }
    let expected: Option<(LinkTypes, AnyLinkableHash)> = match link_type {
        LinkTypes::StoreToEvent | LinkTypes::DriverToEvent | LinkTypes::CustomerToEvent => {
            decode::<ReputationEvent>(&record).map(|e| {
                let (t, _, b) = event_link(&e.target);
                (t, b)
            })
        }
        LinkTypes::StoreToReputationCheckpoint | LinkTypes::DriverToReputationCheckpoint | LinkTypes::CustomerToReputationCheckpoint => {
            decode::<ReputationCheckpoint>(&record).map(|c| {
                let (_, t, b) = event_link(&c.target);
                (t, b)
            })
        }
        LinkTypes::StoreToReview | LinkTypes::DriverToReview => decode::<Review>(&record).map(|r| {
            let (t, _, b) = review_link(&r.target);
            (t, b)
        }),
        LinkTypes::StoreToRatingCheckpoint | LinkTypes::DriverToRatingCheckpoint => decode::<RatingCheckpoint>(&record).map(|c| {
            let (_, t, b) = review_link(&c.target);
            (t, b)
        }),
        LinkTypes::OrderToReview => match decode::<Review>(&record) {
            Some(review) => Some((LinkTypes::OrderToReview, original_creation(review.order_ref)?.into())),
            None => None,
        },
        LinkTypes::ItemToReview => decode::<ItemReview>(&record).map(|r| (LinkTypes::ItemToReview, r.item_ref.into())),
        LinkTypes::ItemToRatingCheckpoint => decode::<ItemRatingCheckpoint>(&record).map(|c| (LinkTypes::ItemToRatingCheckpoint, c.item_ref.into())),
    };
    let Some((expected_type, expected_base)) = expected else {
        return invalid("a reputation link's target is not the entry type its link type indexes");
    };
    require(
        expected_type == link_type && &expected_base == base,
        "a reputation link must sit under the store, agent, order or item its entry is actually about",
    )
}

/// Reputation is append-only: events, reviews and checkpoints are never
/// unlinked.
pub fn validate_delete_link() -> ExternResult<ValidateCallbackResult> {
    invalid("reputation links can't be deleted")
}
