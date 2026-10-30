// The development host's memory of which identity this browser is (see
// host.ts) -- kept apart from `devHost.ts` so checking for one doesn't load
// the Admin API code.

import { forget, readStoredJson, store } from "../lib/util/storage";

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
  return readStoredJson<StoredIdentity>(STORAGE_KEY);
}

export function saveStoredIdentity(identity: StoredIdentity) {
  store(STORAGE_KEY, JSON.stringify(identity));
}

export function forgetStoredIdentity() {
  forget(STORAGE_KEY);
}

/// Whether the identity this browser remembers is behind a passkey -- so
/// unlocking it waits for a tap: browsers (Safari above all) refuse or
/// stall a passkey prompt nobody asked for.
export function storedIdentityNeedsUnlock(): boolean {
  return !!loadStoredIdentity()?.credentialId;
}
