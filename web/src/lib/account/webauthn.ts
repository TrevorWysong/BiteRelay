// A local app-lock, not a remote-authentication protocol -- there is no
// server here to verify a signature against (this app has no backend at
// all, by design), so this isn't "real" WebAuthn relying-party verification
// in the sense the spec is built for. What it *does* provide, stated
// plainly rather than oversold: `navigator.credentials.get()` only resolves
// after the platform authenticator (Touch ID / Windows Hello / device PIN)
// confirms the device owner's presence against a credential scoped to this
// origin. That's a real, hardware-backed gate against "someone else picks
// up my unlocked device and opens HandShake" -- which a bare localStorage-based
// identity (this app's actual private key material lives in lair-keystore,
// never in the browser at all -- see admin.ts) has zero protection against
// today. It does NOT encrypt the stored identity at rest, and does NOT
// protect against a determined attacker with devtools/JS execution already
// running on this origin -- naming both limits rather than letting the
// name "WebAuthn" imply more than this actually buys.
import { bytesToBase64, base64ToBytes } from "../util/base64";

const RP_NAME = "HandShake";

export function isWebAuthnAvailable(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;
}

/// The `publicKey.timeout` option is only a hint user agents may ignore
/// (with no platform authenticator, `create()` can hang indefinitely). An
/// abort `signal` is spec-required to end the ceremony, so it's what bounds
/// the wait (with `withTimeout` as a backstop for browsers that ignore it).
const CEREMONY_TIMEOUT_MS = 60000;
function ceremonySignal(ms: number = CEREMONY_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

// Typed as BufferSource at the source, rather than cast at every call site
// -- TS's DOM lib narrows BufferSource to reject a generic
// Uint8Array<ArrayBufferLike>, even though a freshly `new Uint8Array(n)`
// allocation is always backed by a real ArrayBuffer, never a
// SharedArrayBuffer, at runtime.
function randomChallenge(): BufferSource {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes as BufferSource;
}

// WebAuthn's own types deal in ArrayBuffer, not Uint8Array -- these just
// adapt the shared byte<->base64 codec (lib/util/base64.ts) to that view type
// rather than carrying a second copy of the same encode/decode loop.
function bufferToBase64(buf: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buf));
}

function base64ToBuffer(b64: string): ArrayBuffer {
  // Same reasoning as randomChallenge()'s cast above -- a freshly allocated
  // Uint8Array's .buffer is always a real ArrayBuffer at runtime, never a
  // SharedArrayBuffer; TS's lib.dom types just can't express that narrowing.
  return base64ToBytes(b64).buffer as ArrayBuffer;
}

/// Registers a new passkey scoped to this origin, for use as a reconnect
/// gate (see `verifyPasskey`). `userHandle` should be stable per identity --
/// this app passes the agent's own pubkey bytes, which is convenient (no
/// separate ID to invent) but is not treated as secret by WebAuthn itself
/// (`user.id` is opaque to relying parties, never asserted back to us in a
/// way that would leak it further than it already is).
/// `timeoutMs` is shorter by default here than `verifyPasskey`'s bound on
/// purpose: registration is an opportunistic, best-effort step during
/// signup (see session.ts's `createIdentity` -- a device lock is a nice
/// extra, never a requirement to finish onboarding), so a slow or absent
/// authenticator should fail open quickly rather than leaving a brand new
/// user staring at a spinner for a full minute over an optional feature.
/// `verifyPasskey`'s reconnect gate is the opposite case -- the user is
/// actively trying to get back in and *wants* to wait out a slow scan.
export async function registerPasskey(displayName: string, userHandle: Uint8Array, timeoutMs = 15000): Promise<string> {
  const credential = (await navigator.credentials.create({
    signal: ceremonySignal(timeoutMs),
    publicKey: {
      rp: { name: RP_NAME },
      user: { id: userHandle as BufferSource, name: displayName, displayName },
      challenge: randomChallenge(),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256 -- broader authenticator support
      ],
      authenticatorSelection: { userVerification: "required" },
      timeout: timeoutMs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("passkey registration was cancelled or failed");
  return bufferToBase64(credential.rawId);
}

/// Resolves only if the platform authenticator confirms user presence for
/// the given credential; throws otherwise (cancelled, timed out, no
/// matching authenticator available). Callers should treat any rejection
/// as "do not proceed" -- there is no partial-success case here.
export async function verifyPasskey(credentialIdB64: string): Promise<void> {
  const assertion = await navigator.credentials.get({
    signal: ceremonySignal(),
    publicKey: {
      challenge: randomChallenge(),
      allowCredentials: [{ type: "public-key", id: base64ToBuffer(credentialIdB64) }],
      userVerification: "required",
      timeout: CEREMONY_TIMEOUT_MS,
    },
  });
  if (!assertion) throw new Error("passkey verification was cancelled or failed");
}
