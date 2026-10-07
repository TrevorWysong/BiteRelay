// The one piece of client-side state that matters most in a p2p app: *which
// agent is this browser tab*, and is it actually connected to a conductor
// right now. Everything else (cart, UI mode) is disposable; this is not --
// losing it means losing the ability to reconnect as the same identity.
import { create } from "zustand";
import { connect, isConnected, myAgentPubKey } from "../holochain/client";
import { provisionNewIdentity, reconnectIdentity } from "../holochain/admin";
import { createProfile, getProfileForAgent } from "../holochain/zomes/profiles";
import { actionHash, decodeEntry } from "../holochain/decode";
import { bytesToBase64, base64ToBytes } from "../lib/base64";
import { isArbitrator as checkIsArbitrator } from "../holochain/governance";
import { isWebAuthnAvailable, registerPasskey, verifyPasskey } from "../lib/webauthn";
import { describeError } from "../lib/errors";
import { withTimeout } from "../lib/timeout";
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

const LOCATION_STORAGE_KEY = "relay.location.v1";

/// `location` drives every geohash-anchored discovery read in the app
/// (Browse's "restaurants near me", goodie bags, driver/order matching).
/// Found live: with no persistence here, every page reload/reconnect
/// silently reset it back to the hardcoded Florida default below,
/// regardless of whatever real address a merchant/customer had actually
/// picked earlier in the same session -- reading as "0 restaurants
/// nearby" for a real test location hundreds of miles from that default,
/// with nothing about the discovery mechanism itself actually wrong
/// (confirmed directly: `get_nearby_merchants`' own geohash walk finds a
/// merchant from a customer location genuinely one house-lot away, see
/// nearby-precision.test.ts). Same localStorage-backed persistence
/// `StoredIdentity` already uses, so a returning user keeps browsing from
/// wherever they actually are instead of resetting on every reload.
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

  hasStoredIdentity: () => boolean;
  reconnect: () => Promise<void>;
  createIdentity: (
    adminUrl: string,
    displayName: string,
    roles: RoleTag[],
    location: GeoPoint,
    extras?: { bio?: string; avatarDataUri?: string; phone?: string },
  ) => Promise<void>;
  /// Signs this browser in as an identity that already exists on the node
  /// (dev-only: the onboarding picker for seeded identities). No passkey is
  /// registered for it -- those are per-device, set up at creation.
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

  hasStoredIdentity: () => loadStoredIdentity() !== null,

  reconnect: async () => {
    const stored = loadStoredIdentity();
    if (!stored) throw new Error("no stored identity to reconnect");
    set({ status: "connecting", error: null });
    try {
      // Gate *before* touching the admin API at all -- a cancelled/failed
      // passkey check should never even attempt to reconnect the identity.
      // Tagged distinctly so callers that auto-retry (App.tsx's bootstrap)
      // can tell this apart from a transient infra failure -- a Touch
      // ID/Windows Hello prompt is user-interactive and can itself take up
      // to a minute (see webauthn.ts's own ceremony timeout), so blindly
      // retrying it 2-3 more times on failure means up to several more
      // minutes of prompts stacking up, which reads as the page freezing,
      // not as a helpful retry.
      if (stored.credentialId) {
        try {
          // Independent of webauthn.ts's own AbortSignal.timeout() --
          // confirmed directly that Safari can leave a
          // navigator.credentials.get() ceremony hanging well past that
          // signal's deadline with no rejection ever arriving, which is
          // what "the page is frozen, I had to force-quit the browser" was.
          // This backstop doesn't depend on Safari cooperating at all.
          await withTimeout(verifyPasskey(stored.credentialId), 30000, "Sign-in prompt timed out");
        } catch (err) {
          const tagged = new Error(describeError(err));
          tagged.name = "PasskeyError";
          throw tagged;
        }
      }
      // Same backstop for the rest of the sequence -- none of these admin
      // API/zome calls have their own timeout at all, so a conductor that
      // genuinely stops responding (vs. just being slow) would otherwise
      // hang this forever too, with no way back to the error UI.
      const agentPubKey = base64ToBytes(stored.agentPubKeyB64);
      const identity = await withTimeout(reconnectIdentity(stored.adminUrl, stored.installedAppId, agentPubKey), 30000, "Reconnecting to your local node timed out");
      await connect({ url: identity.appUrl, token: new Uint8Array(identity.token) });
      // One call, not getProfileForAgent *then* fetchProfile (which just
      // calls getProfileForAgent again internally) -- decode locally
      // instead of paying for the same zome call twice every reconnect.
      const profileRecord = await getProfileForAgent(myAgentPubKey());
      const profile = profileRecord ? decodeEntry<Profile>(profileRecord) : null;
      const arbitrator = await checkIsArbitrator(myAgentPubKey());
      set({
        status: "connected",
        agentPubKey: myAgentPubKey(),
        profile,
        profileActionHash: profileRecord ? actionHash(profileRecord) : null,
        // Every fresh page load starts a brand new store with `mode`
        // defaulted to "customer" -- without restoring it here too, a
        // driver or merchant reconnecting after any reload (a browser
        // refresh, reopening a PWA, the auto-reconnect bootstrap itself)
        // would land back on the right *route* but with the bottom nav
        // and mode pill still showing customer-mode links, a real and
        // confusing mismatch confirmed directly against a live reconnect.
        mode: profile ? primaryModeForRoles(profile.roles) : "customer",
        isArbitrator: arbitrator,
        hasDeviceLock: !!stored.credentialId,
      });
    } catch (err) {
      set({ status: "error", error: describeError(err) });
      throw err;
    }
  },

  createIdentity: async (adminUrl, displayName, roles, location, extras) => {
    saveStoredLocation(location);
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
      // createProfile already returned the record -- no need for a second
      // get_profile_for_agent zome call just to read back what was sent.
      const profile = decodeEntry<Profile>(profileRecord);
      const arbitrator = await checkIsArbitrator(myAgentPubKey());

      // Best-effort: a device without a platform authenticator (or a user
      // who cancels) still gets a fully working identity, just without the
      // reconnect gate -- this must never block onboarding itself. The
      // explicit timeout matters here as much as in reconnect() -- without
      // it, the same Safari AbortSignal unreliability would hang onboarding
      // itself, not just a later reconnect.
      let credentialId: string | undefined;
      if (isWebAuthnAvailable()) {
        try {
          credentialId = await withTimeout(registerPasskey(displayName, identity.agentPubKey), 20000, "Passkey setup timed out");
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
      set({ status: "error", error: describeError(err) });
      throw err;
    }
  },

  adoptIdentity: async (adminUrl, installedAppId, agentPubKey) => {
    saveStoredIdentity({ adminUrl, installedAppId, agentPubKeyB64: bytesToBase64(agentPubKey) });
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

  signOut: () => {
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  },
}));
