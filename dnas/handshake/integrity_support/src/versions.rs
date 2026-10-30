//! An entry's versions, indexed: each update is linked from the entry's
//! original action, tagged with how many updates deep it is -- so its
//! current version is one read away (`get_links` on the original), where
//! following the updates one at a time takes a read for each.
//!
//! Every integrity zome's first link type is `Version` (each asserts it), so
//! a coordinator reading any entry finds its versions from the entry's own
//! zome, whichever zome it's in.

use hdi::prelude::*;

/// Where `Version` sits among every integrity zome's link types.
pub const VERSION_LINK_TYPE: u8 = 0;

/// Marks a version link's tag.
const TAG_MARK: &[u8] = b"v";

/// A version link's tag: `depth` updates below the original.
pub fn version_tag(depth: u32) -> LinkTag {
    LinkTag::new([TAG_MARK, &depth.to_be_bytes()].concat())
}

/// How deep a version link says its version is.
pub fn version_depth(tag: &LinkTag) -> Option<u32> {
    let bytes = tag.0.strip_prefix(TAG_MARK)?;
    Some(u32::from_be_bytes(bytes.try_into().ok()?))
}

/// Validates a `Version` link: from an entry's original action to one of its
/// updates, by that update's author, tagged with how deep it is -- each
/// checked against the updates themselves. Reads one action per update
/// between them, once, where the link is validated.
pub fn validate_version_link(base: &AnyLinkableHash, target: &AnyLinkableHash, tag: &LinkTag, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let Some(version) = target.clone().into_action_hash() else { return invalid("a version link targets an update") };
    let action = must_get_action(version)?;
    let ActionData::Update(update) = &action.hashed.content.data else { return invalid("a version link targets an update") };
    if action.hashed.content.author() != author {
        return invalid("a version is linked by the one who wrote it");
    }
    let mut depth = 1;
    let mut current = update.original_action_address.clone();
    while let ActionData::Update(earlier) = &must_get_action(current.clone())?.hashed.content.data {
        depth += 1;
        current = earlier.original_action_address.clone();
    }
    if base != &AnyLinkableHash::from(current) {
        return invalid("a version is linked from its entry's original");
    }
    if version_depth(tag) != Some(depth) {
        return invalid("a version link's tag says how many updates deep it is");
    }
    Ok(ValidateCallbackResult::Valid)
}

fn invalid(reason: &str) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(reason.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tag_carries_its_depth() {
        assert_eq!(version_depth(&version_tag(7)), Some(7));
        assert_eq!(version_depth(&LinkTag::new(vec![1, 2])), None);
        assert_eq!(version_depth(&LinkTag::new([TAG_MARK, &[0, 0, 1]].concat())), None);
    }
}
