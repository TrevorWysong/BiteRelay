//! Link validation. A store's menu, promo codes, goodie bags and claims are
//! all read by walking links from the store (or its anchors); these rules
//! make sure each link points at an entry that really belongs where it's
//! linked -- otherwise anyone could, say, inject another store's items
//! into a menu or attach a fake claim to someone's bag.

use crate::*;
use relay_integrity_support::{decode, invalid, link_target, path_hash, require, valid, LinkTarget};

/// Mirrors each coordinator anchor path (catalog/coordinator lib.rs, bags.rs).
pub fn catalog_geohash_path(geohash: &str) -> String {
    format!("catalog_geohash.{geohash}")
}
pub fn promo_path(catalog_ref: &ActionHash) -> String {
    format!("catalog_promo.{catalog_ref}")
}
pub fn bag_path(catalog_ref: &ActionHash) -> String {
    format!("catalog_bag.{catalog_ref}")
}
pub fn claim_path(bag_ref: &ActionHash) -> String {
    format!("bag_claim.{bag_ref}")
}

pub fn validate_create_link(link_type: LinkTypes, base: &AnyLinkableHash, target: &AnyLinkableHash, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let record = match link_target(target)? {
        LinkTarget::Record(record) => record,
        // Anchor path tree links: only these link types are built from paths.
        LinkTarget::PathNode => {
            return require(
                matches!(link_type, LinkTypes::GeohashToCatalog | LinkTypes::CatalogToPromoCode | LinkTypes::CatalogToBag | LinkTypes::BagToClaim),
                "this link type must target a record",
            )
        }
    };
    let entry_author = record.action().author();
    match link_type {
        LinkTypes::OwnerToCatalog | LinkTypes::GeohashToCatalog => {
            let Some(catalog) = decode::<MerchantCatalog>(&record) else { return invalid("target is not a MerchantCatalog") };
            let expected_base: AnyLinkableHash = match link_type {
                LinkTypes::OwnerToCatalog => catalog.owner.clone().into(),
                _ => path_hash(catalog_geohash_path(&catalog.geohash))?,
            };
            require(
                author == &catalog.owner && base == &expected_base,
                "a catalog may only be linked by its owner, from its owner or its own geohash anchor",
            )
        }
        LinkTypes::CatalogToMenuItem => {
            let Some(item) = decode::<MenuItem>(&record) else { return invalid("target is not a MenuItem") };
            require(
                author == entry_author && base == &AnyLinkableHash::from(item.catalog_ref),
                "a menu item may only be linked under its own catalog, by its author",
            )
        }
        LinkTypes::CatalogToPromoCode => {
            let Some(promo) = decode::<PromoCode>(&record) else { return invalid("target is not a PromoCode") };
            require(
                author == entry_author && base == &path_hash(promo_path(&promo.catalog_ref))?,
                "a promo code may only be linked under its own catalog's anchor, by its author",
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
                author == entry_author && base == &path_hash(bag_path(&bag.catalog_ref))?,
                "a goodie bag may only be linked under its own catalog's anchor, by its author",
            )
        }
        LinkTypes::BagToClaim | LinkTypes::CustomerToClaim => {
            let Some(claim) = decode::<BagClaim>(&record) else { return invalid("target is not a BagClaim") };
            let expected_base: AnyLinkableHash = match link_type {
                LinkTypes::BagToClaim => path_hash(claim_path(&claim.bag_ref))?,
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
