// The development host (see host.ts): identities provisioned on the dev
// conductor through its Admin API, remembered by this browser, optionally
// behind a device passkey. Loaded only when `DEV_HOST` holds, so it's never
// part of a production build.
import { connect } from "./client";
import { provisionNewIdentity, reconnectIdentity } from "./admin";
import { loadStoredIdentity, saveStoredIdentity } from "./devIdentityStorage";
import { bytesToBase64, base64ToBytes } from "../lib/base64";
import { describeError } from "../lib/errors";
import { isWebAuthnAvailable, registerPasskey, verifyPasskey } from "../lib/webauthn";
import { withTimeout } from "../lib/timeout";

/// Reconnects as the identity this browser remembers -- behind its passkey,
/// if it has one. A passkey failure is tagged `PasskeyError` so the caller
/// doesn't retry a user-interactive prompt. Returns whether a passkey
/// guards it.
export async function reconnectStoredIdentity(): Promise<boolean> {
  const stored = loadStoredIdentity();
  if (!stored) throw new Error("no stored identity to reconnect");
  // Gate *before* touching the admin API at all.
  if (stored.credentialId) {
    try {
      // A backstop to webauthn.ts's abort signal, which Safari can ignore.
      await withTimeout(verifyPasskey(stored.credentialId), 30000, "Sign-in prompt timed out");
    } catch (err) {
      const tagged = new Error(describeError(err));
      tagged.name = "PasskeyError";
      throw tagged;
    }
  }
  // Same backstop: these admin calls have no timeout of their own.
  const identity = await withTimeout(reconnectIdentity(stored.adminUrl, stored.installedAppId, base64ToBytes(stored.agentPubKeyB64)), 30000, "Reconnecting to your local node timed out");
  await connect({ url: identity.appUrl, token: new Uint8Array(identity.token) });
  return !!stored.credentialId;
}

/// A brand-new identity on the node at `adminUrl`, connected. Call
/// `rememberIdentity` once its profile exists.
export async function provisionAndConnect(adminUrl: string): Promise<{ installedAppId: string; agentPubKey: Uint8Array }> {
  const installedAppId = `relay-${crypto.randomUUID()}`;
  const identity = await provisionNewIdentity(adminUrl, installedAppId);
  await connect({ url: identity.appUrl, token: new Uint8Array(identity.token) });
  return { installedAppId, agentPubKey: identity.agentPubKey };
}

/// Remembers a new identity in this browser, behind a passkey where the
/// device has one -- best-effort, so a device without one (or a cancelled
/// prompt) still signs up. Returns whether a passkey guards it.
export async function rememberIdentity(adminUrl: string, installedAppId: string, agentPubKey: Uint8Array, displayName: string): Promise<boolean> {
  let credentialId: string | undefined;
  if (isWebAuthnAvailable()) {
    try {
      credentialId = await withTimeout(registerPasskey(displayName, agentPubKey), 20000, "Passkey setup timed out");
    } catch {
      credentialId = undefined;
    }
  }
  saveStoredIdentity({ adminUrl, installedAppId, agentPubKeyB64: bytesToBase64(agentPubKey), credentialId });
  return !!credentialId;
}

/// Remembers an identity that already exists on the node (the onboarding
/// picker for seeded people), without a passkey -- those are set up at
/// signup, per device.
export function adoptIdentity(adminUrl: string, installedAppId: string, agentPubKey: Uint8Array) {
  saveStoredIdentity({ adminUrl, installedAppId, agentPubKeyB64: bytesToBase64(agentPubKey) });
}
