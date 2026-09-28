import { callZome } from "../client";
import { decodeEntry } from "../decode";
import type { ActionHash, AgentPubKey, HcRecord, Profile, ProviderCredential, RoleTag } from "../types";

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

export async function updateProfile(originalAction: ActionHash, updatedProfile: Profile): Promise<HcRecord> {
  return callZome("profiles", "update_profile", { original_action: originalAction, updated_profile: updatedProfile });
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

export async function fetchProviderCredential(profileAction: ActionHash): Promise<ProviderCredential | null> {
  const record = await getProviderCredentialForProfile(profileAction);
  return record ? decodeEntry<ProviderCredential>(record) : null;
}
