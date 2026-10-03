// The one piece of client-side state that matters most in a p2p app: *which
// agent is this browser tab*, and is it actually connected to a conductor
// right now. Everything else (cart, UI mode) is disposable; this is not --
// losing it means losing the ability to reconnect as the same identity.
import { create } from "zustand";
import { connect, isConnected, myAgentPubKey } from "../holochain/client";
import { provisionNewIdentity, reconnectIdentity } from "../holochain/admin";
import { createProfile, fetchProfile, getProfileForAgent } from "../holochain/zomes/profiles";
import { actionHash } from "../holochain/decode";
import { bytesToBase64, base64ToBytes } from "../holochain/client";
import { isArbitrator as checkIsArbitrator } from "../holochain/governance";
import { isWebAuthnAvailable, registerPasskey, verifyPasskey } from "../lib/webauthn";
import type { ActionHash, GeoPoint, Profile, RoleTag } from "../holochain/types";

const STORAGE_KEY = "relay.identity.v1";

interface StoredIdentity {
  adminUrl: string;
  installedAppId: string;
  agentPubKeyB64: string;
  /// Absent on identities created before this existed, or on a
  /// device/browser without a platform authenticator available at signup
  /// time -- `reconnect()` simply skips the passkey gate for those, rather
  /// than retroactively requiring something that was never set up.
  credentialId?: string;
}

function loadStoredIdentity(): StoredIdentity | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredIdentity;
  } catch {
    return null;
  }
}

function saveStoredIdentity(id: StoredIdentity) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(id));
}

export type Mode = "customer" | "driver" | "merchant" | "arbitrator";

/// The single source of truth for "which mode does a freshly-signed-up,
/// possibly-multi-role agent land on first." Previously duplicated (once
/// here, once in Onboarding.tsx's own `navigate()` target) with two
/// *different* priority orders -- a Requester+Provider signup would
/// navigate to `/customer` (Onboarding's own Requester-first order) while
/// this store set `mode: "driver"` (the old Provider-first order here),
/// leaving the shell's mode pill and bottom nav visibly out of sync with
/// the actual route on first load. One function, one order, used by both
/// call sites, so they can't drift apart again.
export function primaryModeForRoles(roles: RoleTag[]): "customer" | "driver" | "merchant" {
  if (roles.includes("Requester")) return "customer";
  if (roles.includes("Provider")) return "driver";
  return "merchant";
}

interface SessionState {
  status: "disconnected" | "connecting" | "connected" | "error";
  error: string | null;
  agentPubKey: Uint8Array | null;
  profile: Profile | null;
  profileActionHash: ActionHash | null;
  /// Independent of `profile.roles` -- arbitrators are a DNA-properties
  /// roster (architecture plan §8.1), not a RoleTag, so any agent whose
  /// pubkey happens to be on that roster gets the extra "arbitrator" mode
  /// alongside whatever normal roles they picked at onboarding.
  isArbitrator: boolean;
  /// Whether this identity has a device passkey gating `reconnect()` -- see
  /// `lib/webauthn.ts`'s own doc comment for exactly what this does and
  /// doesn't protect against. Surfaced so the Profile screen can show real
  /// status rather than silently succeeding or failing.
  hasDeviceLock: boolean;
  mode: Mode;
  /// The demo's stand-in for real GPS -- a single lat/lon the user sets once
  /// at onboarding. Real device geolocation would slot in here unchanged;
  /// every zome call downstream just wants a GeoPoint.
  location: GeoPoint;

  hasStoredIdentity: () => boolean;
  reconnect: () => Promise<void>;
  createIdentity: (
    adminUrl: string,
    displayName: string,
    roles: RoleTag[],
    location: GeoPoint,
    extras?: { bio?: string; avatarDataUri?: string; phone?: string },
  ) => Promise<void>;
  setMode: (mode: Mode) => void;
  setLocation: (location: GeoPoint) => void;
  refreshProfile: () => Promise<void>;
  signOut: () => void;
}

export const useSession = create<SessionState>((set) => ({
  status: "disconnected",
  error: null,
  agentPubKey: null,
  profile: null,
  profileActionHash: null,
  isArbitrator: false,
  hasDeviceLock: false,
  mode: "customer",
  location: { lat: 27.7676, lon: -82.6403 }, // St. Petersburg, FL -- matches the backend test suite's own default

  hasStoredIdentity: () => loadStoredIdentity() !== null,

  reconnect: async () => {
    const stored = loadStoredIdentity();
    if (!stored) throw new Error("no stored identity to reconnect");
    set({ status: "connecting", error: null });
    try {
      // Gate *before* touching the admin API at all -- a cancelled/failed
      // passkey check should never even attempt to reconnect the identity.
      if (stored.credentialId) {
        await verifyPasskey(stored.credentialId);
      }
      const agentPubKey = base64ToBytes(stored.agentPubKeyB64);
      const identity = await reconnectIdentity(stored.adminUrl, stored.installedAppId, agentPubKey);
      await connect({ url: identity.appUrl, token: new Uint8Array(identity.token) });
      const profileRecord = await getProfileForAgent(myAgentPubKey());
      const profile = profileRecord ? await fetchProfile(myAgentPubKey()) : null;
      const arbitrator = await checkIsArbitrator(myAgentPubKey());
      set({
        status: "connected",
        agentPubKey: myAgentPubKey(),
        profile,
        profileActionHash: profileRecord ? actionHash(profileRecord) : null,
        isArbitrator: arbitrator,
        hasDeviceLock: !!stored.credentialId,
      });
    } catch (err) {
      set({ status: "error", error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  createIdentity: async (adminUrl, displayName, roles, location, extras) => {
    set({ status: "connecting", error: null, location });
    try {
      const installedAppId = `relay-${crypto.randomUUID()}`;
      const identity = await provisionNewIdentity(adminUrl, installedAppId);
      await connect({ url: identity.appUrl, token: new Uint8Array(identity.token) });

      const now = Date.now() * 1000;
      const profileRecord = await createProfile({
        display_name: displayName,
        roles,
        created_at: now,
        bio: extras?.bio,
        avatar_data_uri: extras?.avatarDataUri,
        phone: extras?.phone,
      });
      const profile = await fetchProfile(myAgentPubKey());
      const arbitrator = await checkIsArbitrator(myAgentPubKey());

      // Best-effort: a device without a platform authenticator (or a user
      // who cancels) still gets a fully working identity, just without the
      // reconnect gate -- this must never block onboarding itself.
      let credentialId: string | undefined;
      if (isWebAuthnAvailable()) {
        try {
          credentialId = await registerPasskey(displayName, identity.agentPubKey);
        } catch {
          credentialId = undefined;
        }
      }

      saveStoredIdentity({ adminUrl, installedAppId, agentPubKeyB64: bytesToBase64(identity.agentPubKey), credentialId });
      const initialMode: Mode = primaryModeForRoles(roles);
      set({
        status: "connected",
        agentPubKey: myAgentPubKey(),
        profile,
        profileActionHash: actionHash(profileRecord),
        mode: initialMode,
        isArbitrator: arbitrator,
        hasDeviceLock: !!credentialId,
      });
    } catch (err) {
      set({ status: "error", error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  setMode: (mode) => set({ mode }),
  setLocation: (location) => set({ location }),

  refreshProfile: async () => {
    if (!isConnected()) return;
    const profileRecord = await getProfileForAgent(myAgentPubKey());
    const profile = profileRecord ? await fetchProfile(myAgentPubKey()) : null;
    set({ profile, profileActionHash: profileRecord ? actionHash(profileRecord) : null });
  },

  signOut: () => {
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  },
}));
