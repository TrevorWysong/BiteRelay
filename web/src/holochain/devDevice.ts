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
import type { DeviceRuntime } from "./device";
import { setIdentityRunning } from "./admin";
import { forgetStoredIdentity, loadStoredIdentity } from "./devIdentityStorage";
import { rememberIdentity } from "./devHost";
import { base64Url, devSealedKey, readDevSealedKey } from "./devSealedKey";
import { base64ToBytes } from "../lib/base64";
import { INVITATION_PREFIX, isInvitation } from "../lib/deviceMove";

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
    // The browser keeps the key as plain base64 (`devIdentityStorage`).
    return devSealedKey(base64ToBytes(identity.agentPubKeyB64), { adminUrl: identity.adminUrl, installedAppId: identity.installedAppId });
  },

  stay: async () => {
    const identity = stored();
    await setIdentityRunning(identity.adminUrl, identity.installedAppId, true);
  },

  // The new browser runs the app now: this one only forgets it.
  retire: async () => forgetStoredIdentity(),

  receive: async (sealed) => {
    const read = readDevSealedKey(sealed);
    if (!read) throw new Error("That isn't a code from Relay's move to a new phone.");
    const { account, where } = read;
    await setIdentityRunning(where.adminUrl, where.installedAppId, true);
    // The app reloads next, and signs in as this.
    await rememberIdentity(where.adminUrl, where.installedAppId, account, "Relay");
  },
};
