//! Integrity zome for agent identity: `Profile` and `ProviderCredential`.

use hdi::prelude::*;
pub use relay_types::DeliveryCapability;

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

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    Profile(Profile),
    ProviderCredential(ProviderCredential),
}

#[hdk_link_types]
pub enum LinkTypes {
    AgentToProfile,
    /// Lets any peer find a driver's vehicle info starting only from the
    /// driver's Profile action -- without this, `get_provider_credential`
    /// requires already knowing the credential's own action hash, which
    /// nothing else in the system would ever have handed you.
    ProfileToProviderCredential,
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry, .. }) => match app_entry {
            EntryTypes::Profile(profile) => validate_profile(&profile),
            EntryTypes::ProviderCredential(credential) => validate_provider_credential(&credential),
        },
        FlatOp::CreateEntry(OpEntry::UpdateEntry { app_entry, .. }) => match app_entry {
            EntryTypes::Profile(profile) => validate_profile(&profile),
            EntryTypes::ProviderCredential(credential) => validate_provider_credential(&credential),
        },
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
