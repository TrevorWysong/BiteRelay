import { callZome } from "../client";
import { decodeEntry } from "../decode";
import type { ActionHash, AddressDetails, AgentPubKey, HcRecord, Profile, ProviderCredential, RoleTag } from "../types";

export async function createProfile(input: {
  display_name: string;
  roles: RoleTag[];
  created_at: number;
  bio?: string;
  avatar_data_uri?: string;
  phone?: string;
}): Promise<HcRecord> {
  return callZome("profiles", "create_profile", {
    bio: "",
    avatar_data_uri: "",
    phone: "",
    ...input,
  });
}

export async function getProfileForAgent(agent: AgentPubKey): Promise<HcRecord | null> {
  return callZome("profiles", "get_profile_for_agent", agent);
}

/// A profile as this client sends it: the phone in the clear (the zome
/// seals it to the caller before storing it).
export interface ProfileInput {
  display_name: string;
  roles: RoleTag[];
  created_at: number;
  bio: string;
  avatar_data_uri: string;
  phone: string;
}

export async function updateProfile(originalAction: ActionHash, updatedProfile: ProfileInput): Promise<HcRecord> {
  return callZome("profiles", "update_profile", { original_action: originalAction, updated_profile: updatedProfile });
}

/// The caller's own phone number -- only they can read it.
export async function getMyPhone(): Promise<string | null> {
  return callZome("profiles", "get_my_phone", null);
}

export async function fetchProfile(agent: AgentPubKey): Promise<Profile | null> {
  const record = await getProfileForAgent(agent);
  return record ? decodeEntry<Profile>(record) : null;
}

export async function registerProviderCredential(credential: ProviderCredential): Promise<HcRecord> {
  return callZome("profiles", "register_provider_credential", credential);
}

export async function getProviderCredentialForProfile(profileAction: ActionHash): Promise<HcRecord | null> {
  return callZome("profiles", "get_provider_credential_for_profile", profileAction);
}

// --- favorite restaurants -- a customer's own saved-restaurant list, a
// plain link (no entry type), see profiles' integrity crate for why ---

export async function addFavorite(catalogRef: ActionHash): Promise<void> {
  return callZome("profiles", "add_favorite", catalogRef);
}

export async function removeFavorite(catalogRef: ActionHash): Promise<void> {
  return callZome("profiles", "remove_favorite", catalogRef);
}

export async function listFavorites(): Promise<ActionHash[]> {
  return callZome("profiles", "list_favorites", null);
}

export async function fetchProviderCredential(profileAction: ActionHash): Promise<ProviderCredential | null> {
  const record = await getProviderCredentialForProfile(profileAction);
  return record ? decodeEntry<ProviderCredential>(record) : null;
}

// --- saved addresses -- a customer's own named address book ("Home",
// "Work", ...), the DoorDash/UberEats-style "deliver to" switcher. ---

/// A saved address, opened for its owner (it's stored sealed).
export interface SavedAddressView {
  original_action: ActionHash;
  address: AddressDetails;
}

export async function saveAddress(address: AddressDetails): Promise<HcRecord> {
  return callZome("profiles", "save_address", address);
}

export async function updateSavedAddress(originalAction: ActionHash, address: AddressDetails): Promise<HcRecord> {
  return callZome("profiles", "update_saved_address", { original_action: originalAction, address });
}

export async function deleteSavedAddress(originalAction: ActionHash): Promise<void> {
  return callZome("profiles", "delete_saved_address", originalAction);
}

export async function listMyAddresses(): Promise<SavedAddressView[]> {
  return callZome("profiles", "list_my_addresses", null);
}
