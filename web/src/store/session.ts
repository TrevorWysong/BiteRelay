// The one piece of client-side state that matters most in a p2p app: *which
// agent is this browser tab*, and is it actually connected to a conductor
// right now. Everything else (cart, UI mode) is disposable; this is not --
// losing it means losing the ability to reconnect as the same identity.
import { create } from "zustand";
import { connectLauncher, isConnected, myAgentPubKey, setRestorer } from "../holochain/client";
import { HOST } from "../holochain/host";
import { forgetStoredIdentity, loadStoredIdentity, storedIdentityNeedsUnlock } from "../holochain/devIdentityStorage";
import { createProfile, getProfileForAgent } from "../holochain/zomes/profiles";
import { chainClosed, successionsOf } from "../holochain/zomes/account";
import { prepareDevice } from "../holochain/device";
import { actionHash, decodeEntry } from "../holochain/decode";
import { describeError } from "../lib/errors";
import { useNetwork } from "./network";
import type { ActionHash, GeoPoint, Profile, RoleTag } from "../holochain/types";
import { readStoredJson, store } from "../lib/storage";
import { nowMicros } from "../lib/format";

/// The development host's identity code (Admin API, passkeys), loaded only
/// where it exists -- see `holochain/host.ts`.
async function devHost() {
  if (!__DEV_HOST__) throw new Error("Relay runs inside the Relay app -- open it there.");
  return import("../holochain/devHost");
}

const LOCATION_STORAGE_KEY = "relay.location.v1";

/// Where the app starts when nothing has been chosen yet (St. Petersburg,
/// FL -- also where the backend tests place their stores). Onboarding shows
/// it and asks for the real address.
const DEFAULT_LOCATION: GeoPoint = { lat: 27.7676, lon: -82.6403 };

/// `location` drives every geohash-anchored discovery read in the app
/// (Browse's "restaurants near me", goodie bags, driver/order matching).
/// Persisted (like `StoredIdentity`) so a reload keeps the address the user
/// picked instead of resetting to the default below -- which, far from them,
/// would show no restaurants nearby.
function loadStoredLocation(): GeoPoint | null {
  return readStoredJson<GeoPoint>(LOCATION_STORAGE_KEY);
}

function saveStoredLocation(location: GeoPoint) {
  store(LOCATION_STORAGE_KEY, JSON.stringify(location));
}

export type Mode = "customer" | "driver" | "merchant";

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
  /// The key this account moved on to, if it has -- recovered onto another
  /// device after this one was lost. This key is done: the app says so
  /// instead of carrying on.
  movedTo: Uint8Array | null;
  /// Whether this account moved to the next version of the network
  /// (MIGRATION.md): its chain here is closed.
  movedToNewVersion: boolean;
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
  /// Whether reconnecting asks for the device passkey -- which must wait
  /// for the person to tap, not fire on page load.
  needsUnlock: () => boolean;
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
  /// Gets this device's own key ready to take over an existing account --
  /// connected, with no profile yet. In development it provisions a new
  /// identity on the node at `devAdminUrl` and remembers it, so a recovery
  /// that waits days for guardians keeps the same key across reloads.
  prepareNewDevice: (devAdminUrl?: string) => Promise<void>;
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
  movedTo: null,
  movedToNewVersion: false,
  hasDeviceLock: false,
  mode: "customer",
  location: loadStoredLocation() ?? DEFAULT_LOCATION,

  hasStoredIdentity: () => HOST === "launcher" || loadStoredIdentity() !== null,
  needsUnlock: () => HOST === "dev" && storedIdentityNeedsUnlock(),

  reconnect: async () => {
    set({ status: "connecting", error: null });
    try {
      let hasDeviceLock = false;
      if (HOST === "launcher") await connectLauncher();
      else hasDeviceLock = await (await devHost()).reconnectStoredIdentity();
      // One call: decode the record here rather than fetching it twice. The
      // network's terms load alongside -- every screen past here quotes them.
      // Whether this account has moved on is read before anything else is
      // shown: a key whose account moved on mustn't carry on as if it hadn't.
      const [profileRecord, successions, closed] = await Promise.all([
        getProfileForAgent(myAgentPubKey()),
        successionsOf(myAgentPubKey()).catch(() => []),
        chainClosed(myAgentPubKey()).catch(() => null),
        useNetwork.getState().load(),
      ]);
      const profile = profileRecord ? decodeEntry<Profile>(profileRecord) : null;
      set({
        status: "connected",
        agentPubKey: myAgentPubKey(),
        profile,
        profileActionHash: profileRecord ? actionHash(profileRecord) : null,
        movedTo: successions[0]?.successor ?? null,
        movedToNewVersion: !!closed,
        // A fresh store defaults `mode` to "customer"; restore it from the
        // profile, or a driver or merchant reloading lands on their route
        // with the customer nav.
        mode: profile ? primaryModeForRoles(profile.roles) : "customer",
        hasDeviceLock,
      });
      // An account this device received from another phone arrives without
      // what's private to a device; set it up, in the background.
      void prepareDevice();
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

      await useNetwork.getState().load();
      const profileRecord = await createProfile({
        display_name: displayName,
        roles,
        created_at: nowMicros(),
        bio: extras?.bio,
        avatar_data_uri: extras?.avatarDataUri,
        phone: extras?.phone,
      });
      const profile = decodeEntry<Profile>(profileRecord);
      const hasDeviceLock = devIdentity ? await (await devHost()).rememberIdentity(devAdminUrl ?? "", devIdentity.installedAppId, devIdentity.agentPubKey, displayName) : false;
      set({
        status: "connected",
        agentPubKey: myAgentPubKey(),
        profile,
        profileActionHash: actionHash(profileRecord),
        mode: primaryModeForRoles(roles),
        hasDeviceLock,
      });
    } catch (err) {
      set({ status: "error", error: describeError(err) });
      throw err;
    }
  },

  prepareNewDevice: async (devAdminUrl) => {
    if (isConnected()) return;
    set({ status: "connecting", error: null });
    try {
      let hasDeviceLock = false;
      if (HOST === "launcher") {
        await connectLauncher();
      } else {
        const dev = await devHost();
        const identity = await dev.provisionAndConnect(devAdminUrl ?? "");
        hasDeviceLock = await dev.rememberIdentity(devAdminUrl ?? "", identity.installedAppId, identity.agentPubKey, "Relay");
      }
      await useNetwork.getState().load();
      set({ status: "connected", agentPubKey: myAgentPubKey(), profile: null, profileActionHash: null, movedTo: null, hasDeviceLock });
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
    setRestorer(null);
    forgetStoredIdentity();
    window.location.reload();
  },
}));
