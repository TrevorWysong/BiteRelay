// Whether this device is part-way through bringing an existing account
// onto it (RestoreAccount) -- remembered, so a reload while guardians vouch
// comes back to it rather than to sign-up. Without storage, a reload starts
// the restore over; the key it made is still remembered by the session.
import { forget, readStored, store } from "./storage";

export type Method = "device" | "phrase" | "guardians" | "previous";

/// Where it's kept: the method chosen.
const RESTORING_KEY = "relay.restoring.v1";

export function isRestoring(): boolean {
  return readStored(RESTORING_KEY) !== null;
}

export function remember(method: Method | null) {
  if (method) store(RESTORING_KEY, method);
  else forget(RESTORING_KEY);
}

export function rememberedMethod(): Method | null {
  const method = readStored(RESTORING_KEY);
  return method === "device" || method === "phrase" || method === "guardians" || method === "previous" ? method : null;
}
