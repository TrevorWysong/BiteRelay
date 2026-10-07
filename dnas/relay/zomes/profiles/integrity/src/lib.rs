//! Integrity zome for agent identity: `Profile`, `ProviderCredential`, and
//! `SavedAddress` (a customer's own named address book -- "Home," "Mom's
//! house," ... -- see that struct's own doc comment).

use catalog_types::MerchantCatalog;
use hdi::prelude::*;
pub use relay_types::{DeliveryCapability, GeoPoint};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum RoleTag {
    Requester,
    Provider,
    Merchant,
}

#[hdk_entry_helper]
#[derive(Clone)]
pub struct Profile {
    pub display_name: String,
    pub roles: Vec<RoleTag>,
    pub created_at: Timestamp,
    /// All three added fields default to empty on decode so records written
    /// before this change (and any client that hasn't caught up to it yet)
    /// still deserialize cleanly -- `#[serde(default)]` rather than a
    /// required field, deliberately, since a Profile is not a versioned
    /// migration path, just an append-friendly struct.
    #[serde(default)]
    pub bio: String,
    /// A data URI (`data:image/...;base64,...`), not a hosted URL -- there's
    /// no image host in this system, so a photo genuinely has to live in the
    /// entry itself. Client-side code is responsible for downscaling before
    /// upload; nothing here enforces a size cap, named as a real, accepted
    /// gap rather than silently unbounded.
    #[serde(default)]
    pub avatar_data_uri: String,
    #[serde(default)]
    pub phone: String,
}

/// Kept separate from `Profile` because verification status churns independently
/// of identity -- a driver's background-check state changes far more often than
/// their display name.
#[hdk_entry_helper]
#[derive(Clone)]
pub struct ProviderCredential {
    pub profile_action: ActionHash,
    pub vehicle_description: String,
    pub capabilities: Vec<DeliveryCapability>,
    pub verified: bool,
    #[serde(default)]
    pub license_plate: String,
    #[serde(default)]
    pub photo_data_uri: String,
}

/// A customer's own named address book -- "Home," "Work," "Mom's house" --
/// decoupled from `location` (the client-only, device-local "where am I
/// browsing from right now" pointer in `session.ts`). DoorDash/UberEats'
/// own "deliver to" switcher is the direct model: pick a saved address (or
/// search a brand new one) to browse/order from, independent of wherever
/// you're physically standing right now -- ordering for someone else at a
/// different address is the whole point, not an edge case.
///
/// Lives on-chain (this zome), not `localStorage`, deliberately: this is
/// real, durable personal data a user would be rightly annoyed to lose,
/// the same tier as their `Profile` itself -- `location`'s own
/// *ephemeral* "which one am I using right now" pointer is the only part
/// of this feature that's appropriately client-local (see session.ts's
/// own `loadStoredLocation` doc comment for why that part is fine to be
/// device-only).
#[hdk_entry_helper]
#[derive(Clone)]
pub struct SavedAddress {
    pub label: String,
    pub location: GeoPoint,
    #[serde(default)]
    pub street: String,
    #[serde(default)]
    pub city: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub zip: String,
    pub created_at: Timestamp,
}

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    Profile(Profile),
    ProviderCredential(ProviderCredential),
    SavedAddress(SavedAddress),
}

#[hdk_link_types]
pub enum LinkTypes {
    AgentToProfile,
    /// Lets any peer find a driver's vehicle info starting only from the
    /// driver's Profile action -- without this, `get_provider_credential`
    /// requires already knowing the credential's own action hash, which
    /// nothing else in the system would ever have handed you.
    ProfileToProviderCredential,
    /// An agent's own saved-restaurant list -- base is always their own
    /// `agent_initial_pubkey`, target is a `MerchantCatalog`'s action hash.
    /// No entry type needed: "I favorited X at time T" is exactly what a
    /// link's own existence + timestamp already records, so a bare link
    /// (favorite) / `delete_link` (unfavorite) pair is the whole feature --
    /// see `validate_new_favorite`/`validate_favorite_removal` below for why
    /// this still needs real validation despite being "just a link."
    AgentToFavorite,
    /// An agent's own saved-address book -- base is always their own
    /// `agent_initial_pubkey`, target is a `SavedAddress`'s *original*
    /// creation action (never re-pointed on update, same stable-identity
    /// discipline `CatalogView` exists to enforce elsewhere -- see that
    /// struct's own doc comment for the bug class this avoids repeating a
    /// third time). "Deleting" a saved address means deleting *this*
    /// link, not the entry (which, like everything on a DHT, can't
    /// actually be erased) -- same soft-delete shape `AgentToFavorite`
    /// already uses.
    OwnerToSavedAddress,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, action }) => match app_entry {
            EntryTypes::Profile(profile) => validate_profile(&profile),
            EntryTypes::ProviderCredential(credential) => validate_provider_credential(&credential),
            EntryTypes::SavedAddress(address) => validate_saved_address(&address, action.author()),
        },
        FlatOp::CreateEntry(OpEntry::UpdateEntry { app_entry, action }) => match app_entry {
            EntryTypes::Profile(profile) => validate_profile_update(&profile, action.author(), &action.original_action_address),
            EntryTypes::ProviderCredential(credential) => validate_provider_credential(&credential),
            EntryTypes::SavedAddress(address) => {
                validate_saved_address_update(&address, action.author(), &action.original_action_address)
            }
        },
        FlatOp::Link(OpLink::CreateLink { link_type: LinkTypes::AgentToFavorite, action }) => validate_new_favorite(&action),
        FlatOp::Link(OpLink::DeleteLink { original_action, link_type: LinkTypes::AgentToFavorite, action }) => {
            validate_favorite_removal(&original_action, &action)
        }
        FlatOp::Link(OpLink::CreateLink { link_type: LinkTypes::OwnerToSavedAddress, action }) => validate_new_saved_address_link(&action),
        FlatOp::Link(OpLink::DeleteLink { original_action, link_type: LinkTypes::OwnerToSavedAddress, action }) => {
            validate_saved_address_removal(&original_action, &action)
        }
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_profile(profile: &Profile) -> ExternResult<ValidateCallbackResult> {
    if profile.display_name.trim().is_empty() {
        return Ok(ValidateCallbackResult::Invalid(
            "display_name must not be empty".into(),
        ));
    }
    if profile.roles.is_empty() {
        return Ok(ValidateCallbackResult::Invalid(
            "a profile must declare at least one role".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// `Profile` has no `owner` field of its own (ownership comes purely from
/// the `AgentToProfile` link base, same as every other agent-identity
/// entry here) -- which means, unlike `DeliveryOrder`/`MerchantCatalog`
/// updates elsewhere in this codebase, there's no entry *content* to check
/// authorship against. Found and fixed as a real, exploitable gap:
/// `update_profile` previously ran content-only validation
/// (`validate_profile`) on *every* update, with nothing stopping any
/// agent from calling it against another agent's own profile hash and
/// successfully overwriting their display_name/roles/bio/phone.
/// `must_get_action` resolves just the original action's own metadata
/// (its real cryptographic author) without needing to decode entry
/// content at all, so this works even though there's no stored field to
/// lean on.
fn validate_profile_update(profile: &Profile, author: &AgentPubKey, original_action_hash: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let original_author = must_get_action(original_action_hash.clone())?.action().author().clone();
    if &original_author != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a profile can only be updated by the agent who created it".into(),
        ));
    }
    validate_profile(profile)
}

/// Two checks, both real: (1) the base must be the author's own agent
/// pubkey -- without this, anyone could author a link claiming *you*
/// favorited something, since `create_link` lets the caller pick any base
/// hash; (2) the target must resolve to a real `MerchantCatalog`, the same
/// "references must resolve to the right type" discipline already applied
/// to `MenuItem.catalog_ref`/`PromoCode`'s item references elsewhere in
/// this codebase -- `must_get_valid_record` is safe here since a
/// `MerchantCatalog`'s *existence* (not any mutable field on it) is all
/// that's being checked.
fn validate_new_favorite(action: &TypedAction<CreateLinkData>) -> ExternResult<ValidateCallbackResult> {
    let Some(base_agent) = action.base_address.clone().into_agent_pub_key() else {
        return Ok(ValidateCallbackResult::Invalid("a favorite link's base must be an agent pubkey".into()));
    };
    if &base_agent != action.author() {
        return Ok(ValidateCallbackResult::Invalid(
            "an agent can only favorite restaurants on their own behalf".into(),
        ));
    }
    let Some(catalog_hash) = action.target_address.clone().into_action_hash() else {
        return Ok(ValidateCallbackResult::Invalid("a favorite link's target must be a MerchantCatalog action hash".into()));
    };
    let record = must_get_valid_record(catalog_hash)?;
    // `to_app_option` errors (not `Ok(None)`) when the entry's own fields
    // don't even deserialize as `T` -- e.g. a `Profile` entry has no
    // `owner` field at all, so decoding it as `MerchantCatalog` fails
    // outright rather than cleanly reporting "wrong type." A real,
    // non-obvious bug caught only by testing against an entry of a
    // genuinely different shape (not just "any other entry," which might
    // happen to decode as both -- see `favorites.test.ts`): both cases
    // mean the same thing here ("not a MerchantCatalog"), so both collapse
    // to `false` rather than letting the decode error propagate as a
    // generic, unfriendly validation failure.
    let is_catalog = matches!(record.entry().to_app_option::<MerchantCatalog>(), Ok(Some(_)));
    if !is_catalog {
        return Ok(ValidateCallbackResult::Invalid(
            "a favorite link's target must point at a real MerchantCatalog entry".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Links are public DHT data -- any peer can discover your favorite link's
/// create-action hash via `get_links` and could otherwise submit a
/// `DeleteLink` against it. Without this check, a stranger could silently
/// unfavorite restaurants on your behalf; requiring the deleting action's
/// author to match the *original* link's author closes that.
fn validate_favorite_removal(
    original_action: &TypedAction<CreateLinkData>,
    action: &TypedAction<DeleteLinkData>,
) -> ExternResult<ValidateCallbackResult> {
    if action.author() != original_action.author() {
        return Ok(ValidateCallbackResult::Invalid(
            "only the agent who favorited a restaurant can unfavorite it".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_provider_credential(credential: &ProviderCredential) -> ExternResult<ValidateCallbackResult> {
    let record = must_get_valid_record(credential.profile_action.clone())?;
    let profile: Profile = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "profile_action does not point at a Profile entry".into()
        )))?;
    if !profile.roles.contains(&RoleTag::Provider) {
        return Ok(ValidateCallbackResult::Invalid(
            "ProviderCredential can only be attached to a Profile with the Provider role".into(),
        ));
    }
    if credential.vehicle_description.trim().is_empty() {
        return Ok(ValidateCallbackResult::Invalid(
            "vehicle_description must not be empty".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

fn validate_saved_address(address: &SavedAddress, _author: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if address.label.trim().is_empty() {
        return Ok(ValidateCallbackResult::Invalid("a saved address needs a label (e.g. \"Home\")".into()));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Same shape as `validate_profile_update` -- `SavedAddress` has no
/// `owner` field either, so authorship has to come from the original
/// action's own metadata, not entry content.
fn validate_saved_address_update(address: &SavedAddress, author: &AgentPubKey, original_action_hash: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    let original_author = must_get_action(original_action_hash.clone())?.action().author().clone();
    if &original_author != author {
        return Ok(ValidateCallbackResult::Invalid(
            "a saved address can only be updated by the agent who created it".into(),
        ));
    }
    validate_saved_address(address, author)
}

/// Same reasoning as `validate_new_favorite`'s own base-address check --
/// without this, anyone could author an `OwnerToSavedAddress` link
/// claiming *you* saved some address, since `create_link` lets the caller
/// pick any base hash. Unlike favorites, the target here is this zome's
/// own `SavedAddress` (not a cross-crate `MerchantCatalog`), so no
/// `must_get_valid_record`/duck-type-decode risk applies -- the entry's
/// own `CreateEntry` validation (`validate_saved_address`) already covers
/// its shape.
fn validate_new_saved_address_link(action: &TypedAction<CreateLinkData>) -> ExternResult<ValidateCallbackResult> {
    let Some(base_agent) = action.base_address.clone().into_agent_pub_key() else {
        return Ok(ValidateCallbackResult::Invalid("a saved-address link's base must be an agent pubkey".into()));
    };
    if &base_agent != action.author() {
        return Ok(ValidateCallbackResult::Invalid(
            "an agent can only save addresses to their own address book".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Same reasoning as `validate_favorite_removal` -- links are public DHT
/// data, so without this check a stranger could silently delete entries
/// from your address book.
fn validate_saved_address_removal(
    original_action: &TypedAction<CreateLinkData>,
    action: &TypedAction<DeleteLinkData>,
) -> ExternResult<ValidateCallbackResult> {
    if action.author() != original_action.author() {
        return Ok(ValidateCallbackResult::Invalid(
            "only the agent who saved an address can remove it".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}
