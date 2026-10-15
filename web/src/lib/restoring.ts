// Whether this device is part-way through bringing an existing account
// onto it (RestoreAccount) -- remembered, so a reload while guardians vouch
// comes back to it rather than to sign-up.

export type Method = "device" | "phrase" | "guardians";

/// Where it's kept: the method chosen.
const RESTORING_KEY = "relay.restoring.v1";

export function isRestoring(): boolean {
  try {
    return localStorage.getItem(RESTORING_KEY) !== null;
  } catch {
    return false;
  }
}

export function remember(method: Method | null) {
  try {
    if (method) localStorage.setItem(RESTORING_KEY, method);
    else localStorage.removeItem(RESTORING_KEY);
  } catch {
    // Without storage, a reload starts the restore over; the key it made is
    // still remembered by the session.
  }
}

export function rememberedMethod(): Method | null {
  try {
    const method = localStorage.getItem(RESTORING_KEY);
    return method === "device" || method === "phrase" || method === "guardians" ? method : null;
  } catch {
    return null;
  }
}

