// Decoding a zome-call `Record` back into its app-level struct. Mirrors the
// tryorama test suite's own `decodeEntry` helper (tests/tryorama/src/helpers.ts)
// including its one real gotcha: a countersigned entry's wire shape is
// `[CounterSigningSessionData, bytes]`, not a bare `Uint8Array` -- the actual
// app-entry bytes we want are the second element. `ReceiptAttestation` is the
// only entry type in this app that's ever countersigned, but this helper is
// shared by every zome so it handles both shapes uniformly.
import { decode } from "@msgpack/msgpack";
import type { HcRecord } from "./types";

export function decodeEntry<T>(record: HcRecord): T {
  const entry = record.entry as { Present?: { entry_type: string; entry: Uint8Array | [unknown, Uint8Array] } };
  if (!entry.Present) throw new Error("record has no entry data");
  const raw = entry.Present.entry_type === "CounterSign"
    ? (entry.Present.entry as [unknown, Uint8Array])[1]
    : (entry.Present.entry as Uint8Array);
  return decode(raw) as T;
}

export function actionHash(record: HcRecord): Uint8Array {
  return record.signed_action.hashed.hash;
}

export function authorOf(record: HcRecord): Uint8Array {
  return record.signed_action.hashed.content.author;
}

export function timestampOf(record: HcRecord): number {
  return record.signed_action.hashed.content.timestamp;
}

// Byte-array equality/keying -- Uint8Array can't be used directly as a Map
// key or compared with `===`, and this app compares hashes/agent keys
// constantly (matching a bid to its bidder, checking "is this my order").
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function bytesEqual(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
