// The two codes phones show each other to move an account with its key
// (RECOVERY.md) -- what the app reads to refuse anything else early and to
// show a fingerprint the person compares on both screens. The runtime makes
// and opens them (runtime/device/src/code.rs, which this must agree with):
//
//   - the new phone's invitation, `relay-move:1:` and the public half of a
//     one-time encryption key in its keystore;
//   - the old phone's sealed key, `relay-key:1:` and the account, the key
//     sealed to that invitation.
//
// Both base64url, unpadded.
import type { AgentPubKey } from "../holochain/types";

export const INVITATION_PREFIX = "relay-move:1:";
export const SEALED_KEY_PREFIX = "relay-key:1:";

/// Holochain's prefix for an agent key.
const AGENT_PREFIX = [0x84, 0x20, 0x24];
/// The account, the sender's key, the nonce, and the least ciphertext.
const SEALED_MIN_BYTES = 39 + 32 + 24 + 17;

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function body(code: string, prefix: string): Uint8Array | null {
  const trimmed = code.trim();
  return trimmed.startsWith(prefix) ? fromBase64Url(trimmed.slice(prefix.length)) : null;
}

/// Whether `code` is a new phone's invitation.
export function isInvitation(code: string): boolean {
  return body(code, INVITATION_PREFIX)?.length === 32;
}

/// The account a sealed key carries -- `null` for anything else.
export function sealedAccount(code: string): AgentPubKey | null {
  const bytes = body(code, SEALED_KEY_PREFIX);
  if (!bytes || bytes.length < SEALED_MIN_BYTES || !AGENT_PREFIX.every((b, i) => bytes[i] === b)) return null;
  return bytes.slice(0, 39);
}

/// A short fingerprint of an invitation, to compare on both phones: whoever
/// scans the wrong code (someone else's phone) sees a different one.
export function invitationFingerprint(code: string): string {
  const bytes = body(code, INVITATION_PREFIX) ?? new Uint8Array();
  // 48 bits: too many for someone to make a key of their own that shows the
  // same one in the moment it takes to scan.
  const hex = Array.from(bytes.slice(-6), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)} ${hex.slice(8)}`;
}

