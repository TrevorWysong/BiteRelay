//! Integrity zome for merchant catalogs: `MerchantCatalog` (owner, location,
//! open/closed), `MenuItem` (must reference a real catalog), and `PromoCode`
//! (merchant-scoped discount codes).

use hdi::prelude::*;
use relay_integrity_support::limits::*;
use relay_integrity_support::{first_problem, image_problem, text_problem};
use relay_integrity_support::{classify, decode, invalid, Checked};

mod links;
pub use links::{bag_path, catalog_geohash_path, claim_path, promo_path};

// MerchantCatalog/MenuItem/PromoCode now live in catalog_types so
// dispatch_integrity can decode a PromoCode too, for its own promo-code
// validation in validate_new_order -- see that crate's doc comment for why
// a direct dependency on this crate wouldn't work. Re-exported here so
// nothing else in this crate or the coordinator crate (which imports via
// `catalog_integrity::*`) needs to change.
pub use catalog_types::{BagClaim, BagClaimFulfillment, BagClaimStatus, GoodieBag, MenuItem, MerchantCatalog, OpeningPeriod, PromoCode, PromoRequirement, PromoReward};

/// Precision used for the merchant-discovery anchor -- coarse (city-block
/// scale), matching open orders' drop-off precision so both discovery paths
/// compose over the same geohash grid.
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
    /// A store's currently active promo codes, base = the store. Linked
    /// when a code is created or reactivated and unlinked when it's
    /// deactivated, so checkout reads only the codes it could apply,
    /// however many a store has retired. `CatalogToPromoCode` stays the
    /// permanent, paginated list the merchant manages.
    CatalogToLivePromo,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match classify(op.flattened::<EntryTypes, LinkTypes>()?)? {
        Checked::Create { entry, action } => match entry {
            EntryTypes::MerchantCatalog(catalog) => validate_catalog(&catalog, action.author()),
            EntryTypes::MenuItem(item) => validate_menu_item(&item, action.author()),
            EntryTypes::PromoCode(promo) => validate_new_promo_code(&promo, action.author()),
            EntryTypes::GoodieBag(bag) => validate_new_goodie_bag(&bag, action.author(), action.timestamp()),
            EntryTypes::BagClaim(claim) => validate_new_claim(&claim, action.author(), action.timestamp()),
        },
        Checked::Update { entry, action } => match entry {
            EntryTypes::MerchantCatalog(catalog) => validate_catalog_update(&catalog, action.author(), &action.original_action_address),
            EntryTypes::MenuItem(item) => validate_menu_item_update(&item, action.author(), &action.original_action_address),
            EntryTypes::PromoCode(promo) => validate_promo_code_update(&promo, action.author(), &action.original_action_address),
            EntryTypes::GoodieBag(bag) => validate_goodie_bag_update(&bag, action.author(), &action.original_action_address),
            EntryTypes::BagClaim(claim) => validate_claim_confirmation(&claim, action.author(), &action.original_action_address),
        },
        // A store's menu, promos and bags are retired by updating them
        // (unavailable, inactive), never deleted: orders and reviews cite them.
        Checked::Delete { .. } => invalid("catalog entries can't be deleted"),
        Checked::CreateLink { link_type, action } => links::validate_create_link(link_type, &action.base_address, &action.target_address, action.author()),
        Checked::DeleteLink { original, action, .. } => links::validate_delete_link(original.author(), action.author()),
        Checked::Other => Ok(ValidateCallbackResult::Valid),
    }
}

/// A store's details, changed only by its owner: the version being updated
/// must be theirs, and the store stays theirs. (Each version is checked the
/// same way when written, so every version of a store is its owner's.)
fn validate_catalog_update(catalog: &MerchantCatalog, author: &AgentPubKey, original: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let prior_record = must_get_valid_record(original.clone())?;
    let Some(prior) = decode::<MerchantCatalog>(&prior_record) else {
        return invalid("original_action_hash does not point at a MerchantCatalog entry");
    };
    if prior_record.action().author() != author || &prior.owner != author || catalog.owner != prior.owner {
        return invalid("only a store's owner may change it, and it stays theirs");
    }
    validate_catalog(catalog, author)
}

/// A menu item, changed only by whoever wrote it, and only within its own
/// store.
fn validate_menu_item_update(item: &MenuItem, author: &AgentPubKey, original: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let prior_record = must_get_valid_record(original.clone())?;
    let Some(prior) = decode::<MenuItem>(&prior_record) else {
        return invalid("original_action_hash does not point at a MenuItem entry");
    };
    if prior_record.action().author() != author || item.catalog_ref != prior.catalog_ref {
        return invalid("only a store's owner may change its menu items, and an item stays on its own store's menu");
    }
    validate_menu_item(item, author)
}

fn validate_catalog(catalog: &MerchantCatalog, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if let Some(invalid) = first_problem([
        image_problem(&catalog.banner_data_uri).map(String::from),
        text_problem("business_name", &catalog.business_name, MAX_NAME_CHARS),
        text_problem("description", &catalog.description, MAX_DESCRIPTION_CHARS),
        text_problem("cuisine_type", &catalog.cuisine_type, MAX_LABEL_CHARS),
        text_problem("phone", &catalog.phone, MAX_PHONE_CHARS),
        text_problem("address_street", &catalog.address_street, MAX_STREET_CHARS),
        text_problem("address_city", &catalog.address_city, MAX_PLACE_CHARS),
        text_problem("address_state", &catalog.address_state, MAX_PLACE_CHARS),
        text_problem("address_zip", &catalog.address_zip, MAX_POSTAL_CODE_CHARS),
    ]) {
        return Ok(invalid);
    }
    if catalog.business_name.trim().is_empty() {
        return Ok(ValidateCallbackResult::Invalid("business_name must not be empty".into()));
    }
    if &catalog.owner != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a merchant catalog can only be authored by its own owner".into(),
        ));
    }
    if !catalog.location.is_valid() {
        return Ok(ValidateCallbackResult::Invalid("a store's location must be a real place".into()));
    }
    let radius = catalog.max_delivery_radius_km;
    if !radius.is_finite() || radius <= 0.0 || radius > relay_governance::max_delivery_radius_km() {
        return Ok(ValidateCallbackResult::Invalid(format!("a delivery radius must be more than 0 and at most {} km", relay_governance::max_delivery_radius_km())));
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
    if catalog.weekly_hours.len() > MAX_OPENING_PERIODS {
        return Ok(ValidateCallbackResult::Invalid(format!("a store has at most {MAX_OPENING_PERIODS} opening periods a week")));
    }
    if let Some(problem) = catalog.weekly_hours.iter().find_map(|period| period.problem()) {
        return Ok(ValidateCallbackResult::Invalid(problem.into()));
    }
    if catalog.time_zone.is_empty() || catalog.time_zone.len() > MAX_TIME_ZONE_CHARS {
        return Ok(ValidateCallbackResult::Invalid("time_zone must be an IANA zone name".into()));
    }
    let max_prep = relay_governance::max_prep_minutes();
    if catalog.prep_minutes == 0 || catalog.prep_minutes > max_prep {
        return Ok(ValidateCallbackResult::Invalid(format!("prep_minutes must be between 1 and {max_prep}")));
    }
    if let Some(problem) = dietary_tags_problem(&catalog.dietary_tags) {
        return Ok(ValidateCallbackResult::Invalid(problem));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_menu_item(item: &MenuItem, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if let Some(invalid) = first_problem([
        image_problem(&item.photo_data_uri).map(String::from),
        text_problem("name", &item.name, MAX_NAME_CHARS),
        text_problem("description", &item.description, MAX_DESCRIPTION_CHARS),
        text_problem("category", &item.category, MAX_LABEL_CHARS),
    ]) {
        return Ok(invalid);
    }
    if item.name.trim().is_empty() {
        return Ok(ValidateCallbackResult::Invalid("name must not be empty".into()));
    }
    if let Some(problem) = dietary_tags_problem(&item.dietary_tags) {
        return Ok(ValidateCallbackResult::Invalid(problem));
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
    // `to_app_option` errors (rather than returning `Ok(None)`) for an entry
    // of another type; either way it isn't a menu item.
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
    if let Some(invalid) = first_problem([text_problem("code", &promo.code, MAX_PROMO_CODE_CHARS)]) {
        return Ok(invalid);
    }
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

fn validate_new_goodie_bag(bag: &GoodieBag, author: &AgentPubKey, created: Timestamp) -> ExternResult<ValidateCallbackResult> {
    if (bag.created_at.as_micros() - created.as_micros()).abs() > clock_tolerance_micros() {
        return Ok(ValidateCallbackResult::Invalid("created_at must match when the bag was actually published".into()));
    }
    if bag.pickup_window_end.as_micros() - bag.created_at.as_micros() > relay_governance::goodie_bag_max_lifetime().as_micros() as i64 {
        return Ok(ValidateCallbackResult::Invalid("a goodie bag's pickup window ends too long after it's listed".into()));
    }
    validate_bag_fields(bag, author)
}

/// The rules a bag's content must always satisfy, on creation and update.
fn validate_bag_fields(bag: &GoodieBag, author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if let Some(invalid) = first_problem([
        image_problem(&bag.photo_data_uri).map(String::from),
        text_problem("title", &bag.title, MAX_NAME_CHARS),
        text_problem("description", &bag.description, MAX_DESCRIPTION_CHARS),
    ]) {
        return Ok(invalid);
    }
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

/// Only the presentation may change after listing (title, description,
/// photo). Claims are validated against the bag as created
/// (`must_get_valid_record` is literal), so its window, price, quantity and
/// fulfillment options have to stay what claimants saw -- a merchant who
/// needs different terms lists a new bag.
fn validate_goodie_bag_update(bag: &GoodieBag, author: &AgentPubKey, original_action_hash: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let prior_record = must_get_valid_record(original_action_hash.clone())?;
    let Ok(Some(prior)) = prior_record.entry().to_app_option::<GoodieBag>() else {
        return Ok(ValidateCallbackResult::Invalid("original_action_hash does not point at a GoodieBag entry".into()));
    };
    let terms_unchanged = prior.catalog_ref == bag.catalog_ref
        && prior.original_value_cents == bag.original_value_cents
        && prior.price_cents == bag.price_cents
        && prior.quantity_total == bag.quantity_total
        && prior.pickup_window_start == bag.pickup_window_start
        && prior.pickup_window_end == bag.pickup_window_end
        && prior.supports_pickup == bag.supports_pickup
        && prior.supports_delivery == bag.supports_delivery
        && prior.created_at == bag.created_at;
    if !terms_unchanged {
        return Ok(ValidateCallbackResult::Invalid(
            "a goodie bag update may only change its title, description or photo".into(),
        ));
    }
    validate_bag_fields(bag, author)
}

fn validate_new_claim(claim: &BagClaim, author: &AgentPubKey, claimed: Timestamp) -> ExternResult<ValidateCallbackResult> {
    if (claim.claimed_at.as_micros() - claimed.as_micros()).abs() > clock_tolerance_micros() {
        return Ok(ValidateCallbackResult::Invalid("claimed_at must match when the claim was actually made".into()));
    }
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
    // On-chain expiry: the window can't change after listing (see
    // `validate_goodie_bag_update`), so the bag as created is authoritative.
    if claimed >= bag.pickup_window_end {
        return Ok(ValidateCallbackResult::Invalid("this goodie bag's pickup window has closed".into()));
    }
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

/// How far a self-reported time may sit from its own action's timestamp
/// (`relay_governance::clock_tolerance`): generous enough for clock skew,
/// tight enough that a bag can't be backdated out of (or forward-dated
/// into) its listing window.
fn clock_tolerance_micros() -> i64 {
    relay_governance::clock_tolerance().as_micros() as i64
}

/// Why a list of dietary tags is unacceptable, if it is.
fn dietary_tags_problem(tags: &[String]) -> Option<String> {
    (tags.len() > MAX_DIETARY_TAGS || tags.iter().any(|tag| tag.chars().count() > MAX_LABEL_CHARS)).then(|| format!("at most {MAX_DIETARY_TAGS} dietary tags, each at most {MAX_LABEL_CHARS} characters"))
}
