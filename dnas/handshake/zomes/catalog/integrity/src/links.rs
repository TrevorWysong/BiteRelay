//! Link validation. A store's menu, promo codes, goodie bags and claims are
//! all read by walking links from the store (or its anchors); these rules
//! make sure each link points at an entry that really belongs where it's
//! linked -- otherwise anyone could, say, inject another store's items
//! into a menu or attach a fake claim to someone's bag.

use crate::*;
use catalog_types::LISTING_TAG_PREFIX;
use ledger_types::{LedgerEntry, LedgerKind};
use handshake_integrity_support::{decode, invalid, linked_record, path_hash, require, valid};

/// The anchor a store is listed under, for the geohash cell it's in --
/// mirrored by the coordinator's `geohash_anchor_path`.
pub fn catalog_geohash_path(geohash: &str) -> String {
    format!("catalog_geohash.{geohash}")
}

pub fn validate_create_link(link_type: LinkTypes, link: &TypedAction<CreateLinkData>) -> ExternResult<ValidateCallbackResult> {
    let (base, target, author) = (&link.base_address, &link.target_address, link.author());
    // A listing's tag is reserved to listings, so another zome (the ledger,
    // returning a stake) can recognise one by its tag alone.
    let listing = link_type == LinkTypes::GeohashToCatalog;
    if !listing && link.tag.0.starts_with(LISTING_TAG_PREFIX) {
        return invalid("only a store's listing carries a listing tag");
    }
    // Anchors are computed, never walked: every catalog link targets a
    // record, so nobody can clutter an anchor with links to nowhere.
    let Some(record) = linked_record(target)? else { return invalid("catalog links must target a record") };
    let entry_author = record.action().author();
    match link_type {
        // Validated as a version (`validate`).
        LinkTypes::Version => invalid("a version link is validated as one"),
        LinkTypes::OwnerToCatalog => {
            let Some(catalog) = decode::<MerchantCatalog>(&record) else { return invalid("target is not a MerchantCatalog") };
            require(author == &catalog.owner && base == &AnyLinkableHash::from(catalog.owner.clone()), "a store is linked from its owner, by its owner")
        }
        LinkTypes::GeohashToCatalog => validate_listing(link, &record),
        LinkTypes::CatalogToImport => {
            let Some(import) = decode::<StoreImport>(&record) else { return invalid("target is not a store's import") };
            require(author == entry_author && base == &AnyLinkableHash::from(import.to), "a store's import is linked from the store, by its author")
        }
        LinkTypes::CatalogToSuccessor | LinkTypes::CatalogToPredecessor => {
            let Some(moved) = decode::<StoreSuccession>(&record) else { return invalid("target is not a store's move") };
            let expected = if link_type == LinkTypes::CatalogToSuccessor { moved.from } else { moved.to };
            require(author == entry_author && base == &AnyLinkableHash::from(expected), "a store's move is linked from its stores, by its author")
        }
        LinkTypes::CatalogToMenuItem => {
            let Some(item) = decode::<MenuItem>(&record) else { return invalid("target is not a MenuItem") };
            require(
                author == entry_author && base == &AnyLinkableHash::from(item.catalog_ref),
                "a menu item may only be linked under its own catalog, by its author",
            )
        }
        LinkTypes::CatalogToModifierGroup => {
            let Some(group) = decode::<ModifierGroup>(&record) else { return invalid("target is not a ModifierGroup") };
            require(
                author == entry_author && base == &AnyLinkableHash::from(group.catalog_ref) && matches!(record.action().data, ActionData::Create(_)),
                "a choice group is linked under its own catalog, by its author, by its original action",
            )
        }
        LinkTypes::CatalogToPromoCode => {
            let Some(promo) = decode::<PromoCode>(&record) else { return invalid("target is not a PromoCode") };
            require(
                author == entry_author && base == &AnyLinkableHash::from(promo.catalog_ref),
                "a promo code may only be linked under its own catalog, by its author",
            )
        }
        LinkTypes::CatalogToLivePromo => {
            let Some(promo) = decode::<PromoCode>(&record) else { return invalid("target is not a PromoCode") };
            require(
                author == entry_author && base == &AnyLinkableHash::from(promo.catalog_ref),
                "a promo code may only be listed as live under its own catalog, by its author",
            )
        }
        LinkTypes::CatalogToBag => {
            let Some(bag) = decode::<GoodieBag>(&record) else { return invalid("target is not a GoodieBag") };
            require(
                author == entry_author && base == &AnyLinkableHash::from(bag.catalog_ref),
                "a goodie bag may only be linked under its own catalog, by its author",
            )
        }
        LinkTypes::BagToClaim | LinkTypes::CustomerToClaim => {
            let Some(claim) = decode::<BagClaim>(&record) else { return invalid("target is not a BagClaim") };
            let expected_base: AnyLinkableHash = match link_type {
                LinkTypes::BagToClaim => claim.bag_ref.clone().into(),
                _ => claim.customer.clone().into(),
            };
            require(
                author == &claim.customer && base == &expected_base,
                "a claim may only be linked by its customer, under its own bag or the customer",
            )
        }
    }
}

/// Only whoever created a link may remove it.
pub fn validate_delete_link(original_author: &AgentPubKey, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if original_author == author {
        valid()
    } else {
        invalid("only a link's own author may delete it")
    }
}

/// A store's listing for customers to find: by its owner, under its own
/// area's anchor, to its original action, backed by a stake (named in its
/// tag) that's the owner's own, for this store and the network's amount --
/// and that backs no other listing. So every listing costs its owner the
/// stake for as long as it stands (`ledger_integrity::validate_unstake`).
fn validate_listing(link: &TypedAction<CreateLinkData>, record: &Record) -> ExternResult<ValidateCallbackResult> {
    let Some(catalog) = decode::<MerchantCatalog>(record) else { return invalid("a listing is of a store") };
    if !matches!(record.action().data, ActionData::Create(_)) || link.author() != &catalog.owner || link.base_address != path_hash(catalog_geohash_path(&catalog.geohash))? {
        return invalid("a store is listed by its owner, under its own area, by its original action");
    }
    let Some(stake_ref) = listing_stake(&link.tag.0) else { return invalid("a listing names the stake that backs it") };
    let stake_record = must_get_valid_record(stake_ref.clone())?;
    let backed = match decode::<LedgerEntry>(&stake_record) {
        Some(LedgerEntry { kind: LedgerKind::Stake { catalog: staked }, amount, .. }) => {
            stake_record.action().author() == link.author() && AnyLinkableHash::from(staked) == link.target_address && amount == handshake_governance::store_listing_stake()
        }
        _ => false,
    };
    if !backed {
        return invalid("a listing is backed by its owner's stake for this store, of the network's amount");
    }
    // One listing per stake: the owner's chain since the stake holds no
    // other link with this tag.
    let staked_at = stake_record.action().timestamp();
    let Some(chain_top) = link.prev_action() else { return invalid("a listing can't open a chain") };
    let earlier = handshake_integrity_support::chain::activity_since(link.author(), chain_top, staked_at)?;
    let reused = earlier.iter().any(|item| matches!(&item.action.hashed.content.data, ActionData::CreateLink(other) if other.tag == link.tag));
    if reused {
        return invalid("a stake backs one listing");
    }
    valid()
}
