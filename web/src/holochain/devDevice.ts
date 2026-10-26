// The dev host standing in for a runtime's device commands (`device.ts`).
// On the shared dev node both "phones" are browsers on the same node, where
// Holochain's restore can't run -- it rebuilds a chain from *other* peers --
// and the key never has to leave the node's keystore. So development moves
// the identity, not the chain: the old browser stops its app, and the new
// one takes over that same app. The codes, the screens and every step the
// person sees are the real ones; the restore itself is proved by
// tests/tryorama/src/device-move.test.ts and runtime/device. A dev sealed
// key carries, in place of the sealed key, where the identity lives on the
// node. Loaded only when `DEV_HOST` holds.
import { decodeHashFromBase64 } from "@holochain/client";
import type { DeviceRuntime } from "./device";
import { setIdentityRunning } from "./admin";
import { forgetStoredIdentity, loadStoredIdentity } from "./devIdentityStorage";
import { rememberIdentity } from "./devHost";
import { INVITATION_PREFIX, SEALED_KEY_PREFIX, isInvitation, sealedAccount } from "../lib/deviceMove";

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

/// Where the identity lives, carried in a dev sealed key.
interface Identity {
  adminUrl: string;
  installedAppId: string;
}

function stored() {
  const identity = loadStoredIdentity();
  if (!identity) throw new Error("This browser isn't signed in.");
  return identity;
}

export const devDevice: DeviceRuntime = {
  oneNode: true,

  canMove: async () => loadStoredIdentity() !== null,

  invite: async () => `${INVITATION_PREFIX}${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`,

  send: async (invitation) => {
    if (!isInvitation(invitation)) throw new Error("That isn't a code from Relay's move to a new phone.");
    const identity = stored();
    await setIdentityRunning(identity.adminUrl, identity.installedAppId, false);
    const where: Identity = { adminUrl: identity.adminUrl, installedAppId: identity.installedAppId };
    const bytes = new Uint8Array([...decodeHashFromBase64(identity.agentPubKeyB64), ...new Uint8Array(32 + 24), ...new TextEncoder().encode(JSON.stringify(where))]);
    return `${SEALED_KEY_PREFIX}${base64Url(bytes)}`;
  },

  stay: async () => {
    const identity = stored();
    await setIdentityRunning(identity.adminUrl, identity.installedAppId, true);
  },

  // The new browser runs the app now: this one only forgets it.
  retire: async () => forgetStoredIdentity(),

  receive: async (sealed) => {
    const account = sealedAccount(sealed);
    if (!account) throw new Error("That isn't a code from Relay's move to a new phone.");
    const where = JSON.parse(new TextDecoder().decode(fromBase64Url(sealed.trim().slice(SEALED_KEY_PREFIX.length)).slice(39 + 32 + 24))) as Identity;
    await setIdentityRunning(where.adminUrl, where.installedAppId, true);
    // The app reloads next, and signs in as this.
    await rememberIdentity(where.adminUrl, where.installedAppId, account, "Relay");
  },
};
