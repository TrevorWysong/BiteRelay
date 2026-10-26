// The dev host's stand-in for a sealed key (`devDevice.ts`): the real
// code's form -- `relay-key:1:`, the account, then 32 + 24 bytes where the
// sender's key and nonce go -- carrying, in place of the ciphertext, where
// the identity lives on the dev node. Kept apart, and pure, so it's tested
// against the reader every code goes through (`lib/deviceMove.ts`).
import { SEALED_KEY_PREFIX, sealedAccount } from "../lib/deviceMove";

/// Where an identity lives on the dev node.
export interface DevIdentity {
  adminUrl: string;
  installedAppId: string;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

/// The code for `account` (its 39 bytes), living at `where`.
export function devSealedKey(account: Uint8Array, where: DevIdentity): string {
  const bytes = new Uint8Array([...account, ...new Uint8Array(32 + 24), ...new TextEncoder().encode(JSON.stringify(where))]);
  return `${SEALED_KEY_PREFIX}${base64Url(bytes)}`;
}

/// The account and where it lives, from a dev code -- `null` for anything else.
export function readDevSealedKey(code: string): { account: Uint8Array; where: DevIdentity } | null {
  const account = sealedAccount(code);
  if (!account) return null;
  try {
    const where = JSON.parse(new TextDecoder().decode(fromBase64Url(code.trim().slice(SEALED_KEY_PREFIX.length)).slice(39 + 32 + 24))) as DevIdentity;
    return typeof where?.adminUrl === "string" && typeof where?.installedAppId === "string" ? { account, where } : null;
  } catch {
    return null;
  }
}

export { base64Url };
