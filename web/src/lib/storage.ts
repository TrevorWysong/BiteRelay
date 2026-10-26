// This browser's storage, for what's worth remembering but never required.
// Storage can refuse (a private window, site data blocked, quota): every
// read then finds nothing, and every write is skipped, instead of throwing
// -- one of these failing must never stop the app.

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/// `key`'s value as JSON -- `null` if there's none, or it isn't JSON.
export function readStoredJson<T>(key: string): T | null {
  const raw = readStored(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered: the app carries on without it.
  }
}

export function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing stored to forget.
  }
}
