// An account carried on by another key, on the app's side: the code a
// device shows so another can name it (a guardian, a verifier, the next
// version of the network), what an account moving to the next network seals
// for its key there (the parcel), and setting a new key up as the same
// person -- their profile, vehicle, and, on a migration, addresses and
// favourites. (Moving to a new phone keeps the key: `deviceMove.ts`.)
import { decodeHashFromBase64, encodeHashToBase64 } from "@holochain/client";
import type { AddressDetails, AgentPubKey, HcRecord, Profile, ProviderCredential, RoleTag } from "../../holochain/types";
import { callPrevious, callZome } from "../../holochain/client";
import { openParcelsOnPrevious } from "../../holochain/zomes/account";
import { addFavorite, createProfile, getMyName, getMyPhone, listFavorites, listMyAddresses, registerProviderCredential, saveAddress } from "../../holochain/zomes/profiles";
import { actionHash, decodeEntry } from "../../holochain/decode";
import { nowMicros } from "../ui/format";

const CODE_PREFIX = "handshake-account:";
/// Holochain's prefix for an agent key.
const AGENT_PREFIX = [0x84, 0x20, 0x24];

/// The code a device shows for its key: scanned by a guardian to vouch, a
/// verifier to verify, or the previous version of the app to move here.
export function accountCode(agent: AgentPubKey): string {
  return `${CODE_PREFIX}${encodeHashToBase64(agent)}`;
}

/// The key an account code names -- `null` for anything else.
export function readAccountCode(text: string): AgentPubKey | null {
  const encoded = text.trim().replace(CODE_PREFIX, "");
  try {
    const key = decodeHashFromBase64(encoded);
    return key.length === 39 && AGENT_PREFIX.every((b, i) => key[i] === b) ? key : null;
  } catch {
    return null;
  }
}

/// A short, readable fingerprint of a key, to compare on two screens.
export function keyFingerprint(agent: AgentPubKey): string {
  const tail = encodeHashToBase64(agent).slice(-8);
  return `${tail.slice(0, 4)} ${tail.slice(4)}`.toUpperCase();
}

/// What only the old key can read, carried to the new one.
interface ParcelContents {
  v: 1;
  name: string;
  phone: string;
  addresses: AddressDetails[];
  favorites: string[];
}

/// The parcel an account moving to the next network seals to its key there.
export async function packParcel(): Promise<string> {
  const [name, phone, addresses, favorites] = await Promise.all([getMyName(), getMyPhone(), listMyAddresses(), listFavorites()]);
  const contents: ParcelContents = { v: 1, name: name ?? "", phone: phone ?? "", addresses: addresses.map((a) => a.address), favorites: favorites.map((f) => encodeHashToBase64(f)) };
  return JSON.stringify(contents);
}

function parcelContents(raw: string): ParcelContents | null {
  try {
    const parsed = JSON.parse(raw) as ParcelContents;
    return parsed?.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/// What the new key knows of the person it's taking over for: their public
/// profile and vehicle, and what the old key sealed to it (only on a
/// migration: a recovered key's old one is lost).
export interface Predecessor {
  profile: Profile | null;
  vehicle: ProviderCredential | null;
  name: string;
  phone: string;
  parcel: ParcelContents | null;
}

/// Where the old account lives: this network (a recovery), or the previous
/// version of it (a migration -- docs/MIGRATION.md).
export type AccountPlace = "here" | "previous";

export async function readPredecessor(predecessor: AgentPubKey, where: AccountPlace = "here"): Promise<Predecessor> {
  const call = where === "here" ? callZome : callPrevious;
  const [profileRecord, parcels] = await Promise.all([
    call<HcRecord | null>("profiles", "get_profile_for_agent", predecessor),
    where === "previous" ? openParcelsOnPrevious() : Promise.resolve([] as string[]),
  ]);
  const profile = profileRecord ? decodeEntry<Profile>(profileRecord) : null;
  const vehicleRecord = profileRecord ? await call<HcRecord | null>("profiles", "get_provider_credential_for_profile", actionHash(profileRecord)).catch(() => null) : null;
  const parcel = parcels.map(parcelContents).findLast((p) => p !== null) ?? null;
  return { profile, vehicle: vehicleRecord ? decodeEntry<ProviderCredential>(vehicleRecord) : null, name: parcel?.name || profile?.display_name || "", phone: parcel?.phone ?? "", parcel };
}

/// Sets the new key up as the person: their profile (as they confirm it),
/// their vehicle if they drive, and -- migrating -- their addresses and
/// favourites. Best-effort past the profile: a favourite whose store is
/// gone doesn't stop the move.
export async function adoptPredecessor(known: Predecessor, name: string, phone: string): Promise<void> {
  const roles: RoleTag[] = known.profile?.roles.length ? known.profile.roles : ["Requester"];
  const record = await createProfile({
    display_name: name.trim(),
    roles,
    created_at: nowMicros(),
    bio: known.profile?.bio ?? "",
    avatar_data_uri: known.profile?.avatar_data_uri ?? "",
    phone: phone.trim(),
  });
  const extras: Promise<unknown>[] = [];
  if (roles.includes("Provider") && known.vehicle) extras.push(registerProviderCredential({ ...known.vehicle, profile_action: actionHash(record), verified: false }));
  for (const address of known.parcel?.addresses ?? []) extras.push(saveAddress(address));
  for (const favorite of known.parcel?.favorites ?? []) extras.push(addFavorite(decodeHashFromBase64(favorite)));
  await Promise.allSettled(extras);
}
