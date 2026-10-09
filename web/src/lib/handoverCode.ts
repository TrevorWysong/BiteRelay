// The handover code a customer's app shows as a QR code at the door, and the
// driver's app scans: the order, its PIN and the PIN's salt. Scanned, it's
// proof the customer handed it over -- the network checks it against the
// order's commitment, `sha256(pin || salt)` (see dispatch `pin`). The salt
// never leaves the customer's device before this moment, so nobody can test
// PINs against the commitment beforehand.
import { bytesToHex, hexToBytes } from "../holochain/decode";
import type { PinSecret } from "../holochain/types";

const PREFIX = "relay-handover:1";

export function encodeHandoverCode(orderHex: string, secret: PinSecret): string {
  return `${PREFIX}:${orderHex}:${secret.pin}:${bytesToHex(Uint8Array.from(secret.salt))}`;
}

/// A scanned code, if it's one: the order it's for, and its secret.
export function decodeHandoverCode(text: string): { orderHex: string; secret: PinSecret } | null {
  const match = /^relay-handover:1:([0-9a-f]+):(\d{6}):([0-9a-f]{32})$/.exec(text.trim());
  if (!match) return null;
  return { orderHex: match[1], secret: { pin: match[2], salt: hexToBytes(match[3]) } };
}

/// Whether `secret` opens `commitment` -- what validation checks, done first
/// on the driver's device so a wrong code is caught at the door.
export async function matchesCommitment(secret: PinSecret, commitment: Uint8Array): Promise<boolean> {
  const pin = new TextEncoder().encode(secret.pin);
  const salt = Uint8Array.from(secret.salt);
  const input = new Uint8Array(pin.length + salt.length);
  input.set(pin);
  input.set(salt, pin.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return digest.length === commitment.length && digest.every((byte, i) => byte === commitment[i]);
}
