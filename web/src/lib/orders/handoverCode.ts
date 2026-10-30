// A code as a QR code, which the driver's app scans: the order, the code
// and its salt. The customer's, at the door, proves they handed the order
// over: the network checks it against the order's commitment,
// `sha256(pin || salt)` (see dispatch `pin`), and the salt never leaves
// their device before the handoff, so nobody can test guesses beforehand.
// The store's, at its counter, checks the driver in -- its own app checks
// it.
import { bytesToHex, hexToBytes } from "../../holochain/decode";
import { HANDOFF_CODE_DIGITS, type PinSecret } from "../../holochain/types";

const PREFIX = "relay-handover:1";
/// The order, the code's digits and its 16-byte salt.
const HANDOVER_PATTERN = new RegExp(`^${PREFIX}:([0-9a-f]+):(\\d{${HANDOFF_CODE_DIGITS}}):([0-9a-f]{32})$`);

export function encodeHandoverCode(orderHex: string, secret: PinSecret): string {
  return `${PREFIX}:${orderHex}:${secret.pin}:${bytesToHex(Uint8Array.from(secret.salt))}`;
}

/// A scanned code, if it's one: the order it's for, and its secret.
export function decodeHandoverCode(text: string): { orderHex: string; secret: PinSecret } | null {
  const match = HANDOVER_PATTERN.exec(text.trim());
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

const PICKUP_PREFIX = "relay-pickup:1";
const PICKUP_PATTERN = new RegExp(`^${PICKUP_PREFIX}:([0-9a-f]+):([0-9a-f]+)$`);

/// A driver's pickup, as a QR code on their screen: the order and their
/// pickup leg. The store scans it to hand the order over -- on its own
/// record, the only proof of a pickup.
export function encodePickupCode(orderHex: string, leg: Uint8Array): string {
  return `${PICKUP_PREFIX}:${orderHex}:${bytesToHex(leg)}`;
}

/// A scanned pickup code, if it's one: the order, and the driver's leg.
export function decodePickupCode(text: string): { orderHex: string; leg: Uint8Array } | null {
  const match = PICKUP_PATTERN.exec(text.trim());
  return match ? { orderHex: match[1], leg: hexToBytes(match[2]) } : null;
}
