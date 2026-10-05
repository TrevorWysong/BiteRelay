//! Integrity zome for merchant catalogs: `MerchantCatalog` (owner, location,
//! open/closed), `MenuItem` (must reference a real catalog), and `PromoCode`
//! (merchant-scoped discount codes).

use hdi::prelude::*;

// MerchantCatalog/MenuItem/PromoCode now live in catalog_types so
// dispatch_integrity can decode a PromoCode too, for its own promo-code
// validation in validate_new_order -- see that crate's doc comment for why
// a direct dependency on this crate wouldn't work. Re-exported here so
// nothing else in this crate or the coordinator crate (which imports via
// `catalog_integrity::*`) needs to change.
pub use catalog_types::{BagClaim, BagClaimFulfillment, BagClaimStatus, MenuItem, MerchantCatalog, PromoCode, PromoRequirement, PromoReward, GoodieBag};

/// Precision used for the merchant-discovery anchor -- coarse (city-block
/// scale), matching the presence-beacon precision in `geo_presence` so both
/// discovery paths compose over the same geohash grid.
pub const CATALOG_GEOHASH_PRECISION: usize = 6;

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    MerchantCatalog(MerchantCatalog),
    MenuItem(MenuItem),
    PromoCode(PromoCode),
    GoodieBag(GoodieBag),
    BagClaim(BagClaim),
}

#[hdk_link_types]
pub enum LinkTypes {
    OwnerToCatalog,
    CatalogToMenuItem,
    GeohashToCatalog,
    CatalogToPromoCode,
    /// A bag's own catalog -> bag discovery link -- `get_nearby_goodie_bags`
    /// joins through the *existing* `GeohashToCatalog` anchor rather than a
    /// parallel geohash anchor for bags: a bag's location *is* its
    /// catalog's location, so there's nothing a second anchor would add.
    CatalogToBag,
    BagToClaim,
    CustomerToClaim,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::MerchantCatalog(catalog) => validate_catalog(&catalog, action.author()),
            EntryTypes::MenuItem(item) => validate_menu_item(&item, action.author()),
            EntryTypes::PromoCode(promo) => validate_new_promo_code(&promo, action.author()),
            EntryTypes::GoodieBag(bag) => validate_new_goodie_bag(&bag, action.author()),
            EntryTypes::BagClaim(claim) => validate_new_claim(&claim, action.author()),
        },
        FlatOp::CreateEntry(OpEntry::UpdateEntry { app_entry, action }) => match app_entry {
            EntryTypes::MerchantCatalog(catalog) => validate_catalog(&catalog, action.author()),
            EntryTypes::MenuItem(item) => validate_menu_item(&item, action.author()),
            EntryTypes::PromoCode(promo) => validate_promo_code_update(&promo, action.author(), &action.original_action_address),
            EntryTypes::GoodieBag(bag) => validate_goodie_bag_update(&bag, action.author()),
            EntryTypes::BagClaim(claim) => validate_claim_confirmation(&claim, action.author(), &action.original_action_address),
        },
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_catalog(catalog: &MerchantCatalog, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if catalog.business_name.trim().is_empty() {
        return Ok(ValidateCallbackResult::Invalid("business_name must not be empty".into()));
    }
    if &catalog.owner != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a merchant catalog can only be authored by its own owner".into(),
        ));
    }
    let expected = relay_types::encode(catalog.location, CATALOG_GEOHASH_PRECISION);
    if catalog.geohash != expected {
        return Ok(ValidateCallbackResult::Invalid(
            "geohash does not match the encoded location".into(),
        ));
    }
    if catalog.delivery_subsidy_percent > 100 {
        return Ok(ValidateCallbackResult::Invalid(
            "delivery_subsidy_percent must be between 0 and 100".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_menu_item(item: &MenuItem, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if item.name.trim().is_empty() {
        return Ok(ValidateCallbackResult::Invalid("name must not be empty".into()));
    }
    if item.price_cents == 0 {
        return Ok(ValidateCallbackResult::Invalid("price_cents must be greater than zero".into()));
    }
    // `catalog_ref` is always the catalog's *original* creation action
    // (set once at add_menu_item time, immutable thereafter), so
    // must_get_valid_record's literalness is exactly right here -- unlike
    // reading current status, "who owns this catalog" never changes after
    // creation, so the as-created record is the correct, and only,
    // reference point.
    let owner = owner_of_catalog(&item.catalog_ref)?;
    if &owner != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a menu item can only be authored by its catalog's own owner".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn owner_of_catalog(catalog_ref: &ActionHash) -> ExternResult<AgentPubKey> {
    let record = must_get_valid_record(catalog_ref.clone())?;
    let Ok(Some(catalog)) = record.entry().to_app_option::<MerchantCatalog>() else {
        return Err(wasm_error!(WasmErrorInner::Guest(
            "catalog_ref does not point at a MerchantCatalog entry".into()
        )));
    };
    Ok(catalog.owner)
}

fn validate_requirement(requirement: &PromoRequirement) -> Option<&'static str> {
    match requirement {
        PromoRequirement::None => None,
        PromoRequirement::MinimumSpend(cents) if *cents == 0 => {
            Some("MinimumSpend must be greater than zero")
        }
        PromoRequirement::MinimumSpend(_) => None,
        PromoRequirement::MinimumItemQuantity { quantity, .. } if *quantity == 0 => {
            Some("MinimumItemQuantity's quantity must be greater than zero")
        }
        PromoRequirement::MinimumItemQuantity { .. } => None,
        PromoRequirement::LoyaltyOrderCount(count) if *count == 0 => {
            Some("LoyaltyOrderCount must be greater than zero")
        }
        PromoRequirement::LoyaltyOrderCount(_) => None,
    }
}

fn validate_reward(reward: &PromoReward) -> Option<&'static str> {
    match reward {
        PromoReward::PercentOffSubtotal(p) if *p == 0 || *p > 100 => {
            Some("PercentOffSubtotal must be between 1 and 100")
        }
        PromoReward::PercentOffSubtotal(_) => None,
        PromoReward::FlatOffSubtotal(cents) if *cents == 0 => {
            Some("FlatOffSubtotal must be greater than zero")
        }
        PromoReward::FlatOffSubtotal(_) => None,
        PromoReward::FreeItem { quantity, .. } if *quantity == 0 => {
            Some("FreeItem's quantity must be greater than zero")
        }
        PromoReward::FreeItem { .. } => None,
        PromoReward::PercentOffItem { percent, quantity, .. } if *percent == 0 || *percent > 100 || *quantity == 0 => {
            Some("PercentOffItem's percent must be between 1 and 100 and quantity must be greater than zero")
        }
        PromoReward::PercentOffItem { .. } => None,
    }
}

/// `item_ref`s named in a requirement/reward (`MinimumItemQuantity`,
/// `FreeItem`, `PercentOffItem`) must be real menu items belonging to
/// *this same* catalog -- otherwise a promo could reference another
/// merchant's item, or something that isn't a menu item at all.
/// `MenuItem.catalog_ref` is set once at creation and never changes, so
/// `must_get_valid_record`'s literalness is exactly right here, same
/// reasoning as `validate_menu_item`'s own ownership check.
fn item_belongs_to_catalog(item_ref: &ActionHash, catalog_ref: &ActionHash) -> ExternResult<bool> {
    let record = must_get_valid_record(item_ref.clone())?;
    // `to_app_option` *errors* (not `Ok(None)`) when the entry's own fields
    // don't even deserialize as `MenuItem` -- e.g. a `PromoCode` entry has
    // no `price_cents` field at all, so decoding it as `MenuItem` fails
    // outright rather than cleanly reporting "wrong type." Both a decode
    // error and a clean `Ok(None)` mean the same thing here ("not a
    // MenuItem"), so both collapse to `false` via `matches!` rather than
    // letting the decode error propagate as a generic, unfriendly
    // validation failure -- the same real bug this fix caught in
    // `profiles_integrity::validate_new_favorite`, caught first there by
    // testing against a genuinely wrong-shaped entry.
    let item: Option<MenuItem> = match record.entry().to_app_option() {
        Ok(item) => item,
        Err(_) => return Ok(false),
    };
    Ok(item.is_some_and(|item| &item.catalog_ref == catalog_ref))
}

fn requirement_item_ref(requirement: &PromoRequirement) -> Option<&ActionHash> {
    match requirement {
        PromoRequirement::MinimumItemQuantity { item_ref, .. } => Some(item_ref),
        _ => None,
    }
}

fn reward_item_ref(reward: &PromoReward) -> Option<&ActionHash> {
    match reward {
        PromoReward::FreeItem { item_ref, .. } => Some(item_ref),
        PromoReward::PercentOffItem { item_ref, .. } => Some(item_ref),
        _ => None,
    }
}

fn validate_new_promo_code(promo: &PromoCode, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if promo.code.trim().is_empty() {
        return Ok(ValidateCallbackResult::Invalid("code must not be empty".into()));
    }
    if let Some(reason) = validate_requirement(&promo.requirement) {
        return Ok(ValidateCallbackResult::Invalid(reason.into()));
    }
    if let Some(reason) = validate_reward(&promo.reward) {
        return Ok(ValidateCallbackResult::Invalid(reason.into()));
    }
    for item_ref in requirement_item_ref(&promo.requirement).into_iter().chain(reward_item_ref(&promo.reward)) {
        if !item_belongs_to_catalog(item_ref, &promo.catalog_ref)? {
            return Ok(ValidateCallbackResult::Invalid(
                "a promo code's item references must be real menu items belonging to the same catalog".into(),
            ));
        }
    }
    let owner = owner_of_catalog(&promo.catalog_ref)?;
    if &owner != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a promo code can only be authored by its catalog's own owner".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Only `active` may ever change -- `code`/`discount`/`catalog_ref`/
/// `expires_at`/`created_at` are fixed at creation, so a code's meaning
/// can't be silently altered out from under an order that already
/// referenced it (`dispatch_integrity::validate_new_order` resolves this
/// entry by reference, not by re-checking the discount amount separately).
fn validate_promo_code_update(promo: &PromoCode, author: &AgentPubKey, original_action_hash: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let owner = owner_of_catalog(&promo.catalog_ref)?;
    if &owner != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a promo code can only be updated by its catalog's own owner".into(),
        ));
    }
    let prior_record = must_get_valid_record(original_action_hash.clone())?;
    let prior: PromoCode = prior_record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "original_action_hash does not point at a PromoCode entry".into()
        )))?;
    let unchanged = prior.catalog_ref == promo.catalog_ref
        && prior.code == promo.code
        && prior.requirement == promo.requirement
        && prior.reward == promo.reward
        && prior.expires_at == promo.expires_at
        && prior.created_at == promo.created_at
        && prior.auto_apply == promo.auto_apply;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "a promo code update may only change active -- every other field must stay the same".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_new_goodie_bag(bag: &GoodieBag, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if bag.title.trim().is_empty() {
        return Ok(ValidateCallbackResult::Invalid("title must not be empty".into()));
    }
    if bag.price_cents == 0 {
        return Ok(ValidateCallbackResult::Invalid("price_cents must be greater than zero".into()));
    }
    if bag.price_cents > bag.original_value_cents {
        return Ok(ValidateCallbackResult::Invalid(
            "price_cents must not exceed original_value_cents -- a goodie bag is a discount, not a markup".into(),
        ));
    }
    if bag.quantity_total == 0 {
        return Ok(ValidateCallbackResult::Invalid("quantity_total must be greater than zero".into()));
    }
    if bag.pickup_window_end <= bag.pickup_window_start {
        return Ok(ValidateCallbackResult::Invalid(
            "pickup_window_end must be after pickup_window_start".into(),
        ));
    }
    if !bag.supports_pickup && !bag.supports_delivery {
        return Ok(ValidateCallbackResult::Invalid(
            "a goodie bag must support pickup, delivery, or both".into(),
        ));
    }
    let owner = owner_of_catalog(&bag.catalog_ref)?;
    if &owner != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a goodie bag can only be authored by its catalog's own owner".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Unlike `PromoCode` (only `active` may change, since an order may already
/// reference it by content), a bag has no such outstanding reference to
/// protect -- a claim only ever points at the bag's identity (`bag_ref`),
/// never its price/quantity/window, so the merchant may freely edit any
/// field up until it's claimed against. Same "owner-authored, no per-field
/// lock" posture `validate_catalog`/`validate_menu_item` already take on
/// their own updates.
fn validate_goodie_bag_update(bag: &GoodieBag, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    validate_new_goodie_bag(bag, author)
}

fn validate_new_claim(claim: &BagClaim, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if &claim.customer != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a bag claim can only be authored by its own customer".into(),
        ));
    }
    if claim.status != BagClaimStatus::Pending {
        return Ok(ValidateCallbackResult::Invalid("a new bag claim must start Pending".into()));
    }
    let bag_record = must_get_valid_record(claim.bag_ref.clone())?;
    let Ok(Some(bag)) = bag_record.entry().to_app_option::<GoodieBag>() else {
        return Ok(ValidateCallbackResult::Invalid("bag_ref does not point at a GoodieBag entry".into()));
    };
    // Mirrors `validate_new_bid`'s self-dealing check: a merchant claiming
    // their own bag is a no-op the ledger would reject anyway (`from == to`),
    // same reasoning, caught here with a clearer reason instead.
    if claim.customer == owner_of_catalog(&bag.catalog_ref)? {
        return Ok(ValidateCallbackResult::Invalid(
            "a merchant cannot claim their own goodie bag".into(),
        ));
    }
    let fulfillment_supported = match &claim.fulfillment {
        BagClaimFulfillment::Pickup => bag.supports_pickup,
        BagClaimFulfillment::Delivery { .. } => bag.supports_delivery,
    };
    if !fulfillment_supported {
        return Ok(ValidateCallbackResult::Invalid(
            "this bag does not support the claimed fulfillment method".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// The merchant confirming a claim -- author must be the bag's own catalog
/// owner (the single authoritative party for this scarce resource, see
/// `BagClaim`'s own doc comment), the prior status must be `Pending`, and
/// nothing but `status` may change. Deliberately does **not** attempt to
/// re-derive "have fewer than `quantity_total` claims already been
/// confirmed for this bag" here -- counting sibling claims is exactly the
/// non-deterministic `get_links` walk this codebase already names as a
/// known, accepted gap for `order_total`/`dietary_tags` (see those doc
/// comments); `catalog::confirm_claim`'s own re-derived count is
/// coordinator-level trust, same tier as those.
fn validate_claim_confirmation(claim: &BagClaim, author: &AgentPubKey, original_action_hash: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let bag_record = must_get_valid_record(claim.bag_ref.clone())?;
    let Ok(Some(bag)) = bag_record.entry().to_app_option::<GoodieBag>() else {
        return Ok(ValidateCallbackResult::Invalid("bag_ref does not point at a GoodieBag entry".into()));
    };
    let owner = owner_of_catalog(&bag.catalog_ref)?;
    if &owner != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a bag claim can only be confirmed by that bag's catalog owner".into(),
        ));
    }
    let prior_record = must_get_valid_record(original_action_hash.clone())?;
    let Ok(Some(prior)) = prior_record.entry().to_app_option::<BagClaim>() else {
        return Ok(ValidateCallbackResult::Invalid("original_action_hash does not point at a BagClaim entry".into()));
    };
    if prior.status != BagClaimStatus::Pending {
        return Ok(ValidateCallbackResult::Invalid("only a Pending claim can be confirmed".into()));
    }
    if claim.status != BagClaimStatus::Confirmed {
        return Ok(ValidateCallbackResult::Invalid("a claim confirmation must set status to Confirmed".into()));
    }
    let unchanged = prior.bag_ref == claim.bag_ref && prior.customer == claim.customer && prior.fulfillment == claim.fulfillment && prior.claimed_at == claim.claimed_at;
    if !unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "a claim confirmation may only change status -- every other field must stay the same".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}
