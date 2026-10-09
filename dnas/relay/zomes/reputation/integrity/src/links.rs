//! Link validation. Every read in this zome (ratings, summaries, review
//! lists) trusts that a link under a base points at an entry *about* that
//! base. Without these rules a peer could, e.g., link genuine one-star
//! reviews of other stores under a competitor's store and drag its rating
//! down -- every entry would still be valid, only the links would lie.

use crate::*;
use relay_integrity_support::{decode, invalid, link_target, original_creation, require, LinkTarget};

/// The link type and base an event about `target` is indexed under.
fn event_link(target: &ReputationTarget) -> (LinkTypes, AnyLinkableHash) {
    match target {
        ReputationTarget::Store(c) => (LinkTypes::StoreToEvent, c.clone().into()),
        ReputationTarget::Driver(a) => (LinkTypes::DriverToEvent, a.clone().into()),
        ReputationTarget::Customer(a) => (LinkTypes::CustomerToEvent, a.clone().into()),
    }
}

fn review_link(target: &ReviewTarget) -> (LinkTypes, AnyLinkableHash) {
    match target {
        ReviewTarget::Store(c) => (LinkTypes::StoreToReview, c.clone().into()),
        ReviewTarget::Driver(a) => (LinkTypes::DriverToReview, a.clone().into()),
    }
}

/// A data link is valid only if its type and base match what the target
/// entry says it's about, it's authored by that entry's own author, and --
/// for the links ratings and summaries are summed from -- its tag carries
/// exactly what the entry says (see `review_tag`/`event_tag`).
pub fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, tag: &LinkTag, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let LinkTarget::Record(record) = link_target(target)? else {
        return invalid("reputation links must target a record");
    };
    if record.action().author() != author {
        return invalid("a reputation link must be authored by the author of the entry it indexes");
    }
    let expected: Option<(LinkTypes, AnyLinkableHash, Option<LinkTag>)> = match link_type {
        LinkTypes::StoreToEvent | LinkTypes::DriverToEvent | LinkTypes::CustomerToEvent => match decode::<ReputationEvent>(&record) {
            Some(e) => {
                let (t, b) = event_link(&e.target);
                Some((t, b, Some(event_tag(&e.kind, &e.order_ref))))
            }
            None => None,
        },
        LinkTypes::StoreToReview | LinkTypes::DriverToReview => match decode::<Review>(&record) {
            Some(r) => {
                let (t, b) = review_link(&r.target);
                Some((t, b, Some(review_tag(r.rating, &original_creation(r.order_ref)?))))
            }
            None => None,
        },
        LinkTypes::OrderToReview => match decode::<Review>(&record) {
            Some(review) => Some((LinkTypes::OrderToReview, original_creation(review.order_ref)?.into(), None)),
            None => None,
        },
        LinkTypes::ItemToReview => match decode::<ItemReview>(&record) {
            Some(r) => Some((LinkTypes::ItemToReview, r.item_ref.into(), Some(review_tag(r.rating, &original_creation(r.order_ref)?)))),
            None => None,
        },
    };
    let Some((expected_type, expected_base, expected_tag)) = expected else {
        return invalid("a reputation link's target is not the entry type its link type indexes");
    };
    if expected_type != link_type || &expected_base != base {
        return invalid("a reputation link must sit under the store, agent, order or item its entry is actually about");
    }
    require(
        expected_tag.is_none_or(|expected| &expected == tag),
        "a rating or event link's tag must carry exactly what its entry says",
    )
}

/// Reputation is append-only: events and reviews are never unlinked.
pub fn validate_delete_link() -> ExternResult<ValidateCallbackResult> {
    invalid("reputation links can't be deleted")
}
