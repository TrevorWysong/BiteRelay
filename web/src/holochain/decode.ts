// Decoding a zome-call `Record` back into its app-level struct -- the same
// as the tryorama suite's `decodeEntry` (tests/tryorama/src/helpers.ts).
import { decode } from "@msgpack/msgpack";
import type { HcRecord } from "./types";

export function decodeEntry<T>(record: HcRecord): T {
  const entry = record.entry as { Present?: { entry: Uint8Array } };
  if (!entry.Present) throw new Error("record has no entry data");
  return decode(entry.Present.entry) as T;
}

export function actionHash(record: HcRecord): Uint8Array {
  return record.signed_action.hashed.hash;
}

/// When the record's action was written, in microseconds.
export function timestampOf(record: HcRecord): number {
  return record.signed_action.hashed.content.header.timestamp;
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
