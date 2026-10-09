// The development host's memory of which identity this browser is (see
// host.ts) -- kept apart from `devHost.ts` so checking for one doesn't load
// the Admin API code.

const STORAGE_KEY = "relay.identity.v1";

export interface StoredIdentity {
  adminUrl: string;
  installedAppId: string;
  agentPubKeyB64: string;
  /// The device passkey gating reconnects, if one was set up at signup
  /// (absent on a device without a platform authenticator).
  credentialId?: string;
}

export function loadStoredIdentity(): StoredIdentity | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredIdentity;
  } catch {
    return null;
  }
}

export function saveStoredIdentity(identity: StoredIdentity) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
}

export function forgetStoredIdentity() {
  localStorage.removeItem(STORAGE_KEY);
}
