// Wake tokens: what a device hands out so others can wake it without
// learning who it is. Each is the device's id and an expiry, encrypted
// with the relay's own key (AES-256-GCM, a random nonce each): two tokens
// for one device look unrelated, nobody but this relay can read them, and
// nobody can make one. A device fetches them in batches, ahead of when it
// needs them, so the relay can't tell when it hands one out either.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Wake {
  device: string;
  /// Milliseconds since the epoch.
  expiresAt: number;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function mintToken(key: Buffer, wake: Wake): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const sealed = Buffer.concat([cipher.update(JSON.stringify([wake.device, wake.expiresAt]), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString("base64url");
}

/// The wake inside `token`, if this relay made it -- whether or not it's
/// expired; `null` for anything else.
export function openToken(key: Buffer, token: string): Wake | null {
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length <= NONCE_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, NONCE_BYTES));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)), decipher.final()]).toString("utf8");
    const [device, expiresAt] = JSON.parse(plain) as [unknown, unknown];
    if (typeof device !== "string" || typeof expiresAt !== "number") return null;
    return { device, expiresAt };
  } catch {
    return null;
  }
}
