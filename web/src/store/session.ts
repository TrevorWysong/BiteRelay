// The one piece of client-side state that matters most in a p2p app: *which
// agent is this browser tab*, and is it actually connected to a conductor
// right now. Everything else (cart, UI mode) is disposable; this is not --
// losing it means losing the ability to reconnect as the same identity.
import { create } from "zustand";
import { connectLauncher, isConnected, myAgentPubKey } from "../holochain/client";
import { HOST } from "../holochain/host";
import { forgetStoredIdentity, loadStoredIdentity } from "../holochain/devIdentityStorage";
import { createProfile, getProfileForAgent } from "../holochain/zomes/profiles";
import { actionHash, decodeEntry } from "../holochain/decode";
import { isArbitrator as checkIsArbitrator } from "../holochain/governance";
import { describeError } from "../lib/errors";
import type { ActionHash, GeoPoint, Profile, RoleTag } from "../holochain/types";

/// The development host's identity code (Admin API, passkeys), loaded only
/// where it exists -- see `holochain/host.ts`.
async function devHost() {
  if (!__DEV_HOST__) throw new Error("Relay runs inside the Relay app -- open it there.");
  return import("../holochain/devHost");
}

const LOCATION_STORAGE_KEY = "relay.location.v1";

/// `location` drives every geohash-anchored discovery read in the app
/// (Browse's "restaurants near me", goodie bags, driver/order matching).
/// Persisted (like `StoredIdentity`) so a reload keeps the address the user
/// picked instead of resetting to the default below -- which, far from them,
/// would show no restaurants nearby.
function loadStoredLocation(): GeoPoint | null {
  const raw = localStorage.getItem(LOCATION_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GeoPoint;
  } catch {
    return null;
  }
}

function saveStoredLocation(location: GeoPoint) {
  localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(location));
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

  /// Whether there's an identity to reconnect as: always, in a launcher
  /// (it's the launcher's agent); in development, one this browser
  /// remembers.
  hasStoredIdentity: () => boolean;
  /// Connects as this app's agent and loads its profile -- which may not
  /// exist yet (a first launch), leaving onboarding to create it.
  reconnect: () => Promise<void>;
  /// Creates this agent's profile. In development it first provisions a
  /// new identity on the node at `devAdminUrl`.
  createIdentity: (
    displayName: string,
    roles: RoleTag[],
    location: GeoPoint,
    extras?: { bio?: string; avatarDataUri?: string; phone?: string },
    devAdminUrl?: string,
  ) => Promise<void>;
  /// Development only: signs this browser in as an identity that already
  /// exists on the node (the onboarding picker for seeded people).
  adoptIdentity: (adminUrl: string, installedAppId: string, agentPubKey: Uint8Array) => Promise<void>;
  setMode: (mode: Mode) => void;
  setLocation: (location: GeoPoint) => void;
  refreshProfile: () => Promise<void>;
  signOut: () => void;
}

export const useSession = create<SessionState>((set, get) => ({
  status: "disconnected",
  error: null,
  agentPubKey: null,
  profile: null,
  profileActionHash: null,
  isArbitrator: false,
  hasDeviceLock: false,
  mode: "customer",
  location: loadStoredLocation() ?? { lat: 27.7676, lon: -82.6403 }, // St. Petersburg, FL -- matches the backend test suite's own default, used only when nothing's been saved yet

  hasStoredIdentity: () => HOST === "launcher" || loadStoredIdentity() !== null,

  reconnect: async () => {
    set({ status: "connecting", error: null });
    try {
      let hasDeviceLock = false;
      if (HOST === "launcher") await connectLauncher();
      else hasDeviceLock = await (await devHost()).reconnectStoredIdentity();
      // One call: decode the record here rather than fetching it twice.
      const profileRecord = await getProfileForAgent(myAgentPubKey());
      const profile = profileRecord ? decodeEntry<Profile>(profileRecord) : null;
      const arbitrator = await checkIsArbitrator(myAgentPubKey());
      set({
        status: "connected",
        agentPubKey: myAgentPubKey(),
        profile,
        profileActionHash: profileRecord ? actionHash(profileRecord) : null,
        // A fresh store defaults `mode` to "customer"; restore it from the
        // profile, or a driver or merchant reloading lands on their route
        // with the customer nav.
        mode: profile ? primaryModeForRoles(profile.roles) : "customer",
        isArbitrator: arbitrator,
        hasDeviceLock,
      });
    } catch (err) {
      set({ status: "error", error: describeError(err) });
      throw err;
    }
  },

  createIdentity: async (displayName, roles, location, extras, devAdminUrl) => {
    saveStoredLocation(location);
    set({ status: "connecting", error: null, location });
    try {
      // A launcher already runs this app as its agent; in development, a
      // new identity is provisioned on the node first.
      let devIdentity: { installedAppId: string; agentPubKey: Uint8Array } | null = null;
      if (HOST === "launcher") {
        if (!isConnected()) await connectLauncher();
      } else {
        devIdentity = await (await devHost()).provisionAndConnect(devAdminUrl ?? "");
      }

      const profileRecord = await createProfile({
        display_name: displayName,
        roles,
        created_at: Date.now() * 1000,
        bio: extras?.bio,
        avatar_data_uri: extras?.avatarDataUri,
        phone: extras?.phone,
      });
      const profile = decodeEntry<Profile>(profileRecord);
      const arbitrator = await checkIsArbitrator(myAgentPubKey());
      const hasDeviceLock = devIdentity ? await (await devHost()).rememberIdentity(devAdminUrl ?? "", devIdentity.installedAppId, devIdentity.agentPubKey, displayName) : false;
      set({
        status: "connected",
        agentPubKey: myAgentPubKey(),
        profile,
        profileActionHash: actionHash(profileRecord),
        mode: primaryModeForRoles(roles),
        isArbitrator: arbitrator,
        hasDeviceLock,
      });
    } catch (err) {
      set({ status: "error", error: describeError(err) });
      throw err;
    }
  },

  adoptIdentity: async (adminUrl, installedAppId, agentPubKey) => {
    (await devHost()).adoptIdentity(adminUrl, installedAppId, agentPubKey);
    await get().reconnect();
  },

  setMode: (mode) => set({ mode }),
  setLocation: (location) => {
    saveStoredLocation(location);
    set({ location });
  },

  refreshProfile: async () => {
    if (!isConnected()) return;
    const profileRecord = await getProfileForAgent(myAgentPubKey());
    const profile = profileRecord ? decodeEntry<Profile>(profileRecord) : null;
    set({ profile, profileActionHash: profileRecord ? actionHash(profileRecord) : null });
  },

  /// Development only: forgets this browser's identity. In a launcher the
  /// identity is the app's own; there's nothing to sign out of.
  signOut: () => {
    forgetStoredIdentity();
    window.location.reload();
  },
}));
