// The app's two data-sync primitives, so no screen hand-rolls an effect for
// "a response arrived for something we've moved away from" or "tear down
// the interval and signal subscription". They're effects on purpose --
// reading, polling and listening to the conductor is syncing with an
// external system -- but they live here, once.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { onLocalSignal } from "../holochain/client";
import type { LocalSignal } from "../holochain/types";

interface PollOptions {
  /// Re-run on this cadence while mounted. Every signal-driven screen must
  /// also poll -- signals are a fast path, never a delivery guarantee (see
  /// `onLocalSignal`'s doc comment).
  pollMs?: number;
  /// Re-run immediately when a matching conductor signal arrives.
  refreshOn?: (signal: LocalSignal) => boolean;
}

/// Runs `run` now, on every `pollMs` tick, and on every matching signal,
/// for as long as `enabled` holds -- the polling-plus-signal loop that
/// several screens otherwise duplicate. `run` always calls the *latest*
/// function passed in (kept in a ref), so callers don't need `useCallback`
/// gymnastics to avoid tearing the interval down on every render.
/// `restartKey` changing restarts the loop (and runs immediately) -- pass
/// whatever identifies *what* is being polled, so moving to a different
/// one fetches it straight away instead of waiting for the next tick.
export function usePolling(run: () => unknown, { pollMs, refreshOn }: PollOptions, enabled = true, restartKey?: string | null) {
  const runRef = useRef(run);
  const filterRef = useRef(refreshOn);
  // Refreshed after every render, before any effect (below) or event
  // handler can read them -- never written during render itself, which
  // concurrent rendering may discard.
  useLayoutEffect(() => {
    runRef.current = run;
    filterRef.current = refreshOn;
  });
  const hasSignalFilter = !!refreshOn;

  useEffect(() => {
    if (!enabled) return;
    const tick = () => void runRef.current();
    tick();
    const interval = pollMs ? setInterval(tick, pollMs) : null;
    const unsub = hasSignalFilter ? onLocalSignal((s) => filterRef.current?.(s) && tick()) : null;
    return () => {
      if (interval) clearInterval(interval);
      unsub?.();
    };
  }, [enabled, pollMs, hasSignalFilter, restartKey]);
}

interface ResourceState<T> {
  key: string | null;
  data: T | undefined;
  error: unknown;
}

export interface Resource<T> {
  /// `undefined` until the first response *for the current key* arrives --
  /// never the previous key's data, so switching (store, order, page id)
  /// can't briefly show the wrong thing.
  data: T | undefined;
  error: unknown;
  /// Re-fetches for the current key (after a mutation, say).
  reload: () => Promise<void>;
  /// Locally updates the current key's data (an optimistic toggle, or
  /// appending a "load more" page) without a refetch.
  mutate: (update: (prev: T | undefined) => T) => void;
}

/// Data read from the conductor, identified by `key` -- a string that
/// changes exactly when the thing being read changes (a hash's hex, an
/// agent + role, ...). `null` means "nothing to read yet". Responses are
/// only ever accepted for the key they were requested for, so a slow reply
/// for a key you've moved away from is dropped instead of overwriting the
/// current one. `fetcher` may close over whatever the key encodes; the
/// latest `fetcher` is always the one called.
export function useResource<T>(key: string | null, fetcher: () => Promise<T>, poll: PollOptions = {}): Resource<T> {
  const [state, setState] = useState<ResourceState<T>>({ key: null, data: undefined, error: undefined });
  const fetcherRef = useRef(fetcher);
  const keyRef = useRef(key);
  // Same after-render refresh as `usePolling`'s refs.
  useLayoutEffect(() => {
    fetcherRef.current = fetcher;
    keyRef.current = key;
  });

  const reload = useCallback(async () => {
    const requestedFor = keyRef.current;
    if (requestedFor === null) return;
    try {
      const data = await fetcherRef.current();
      if (keyRef.current === requestedFor) setState({ key: requestedFor, data, error: undefined });
    } catch (error) {
      // Keep whatever was last loaded for this key -- a failed poll tick
      // shouldn't blank a screen that was showing good data.
      if (keyRef.current === requestedFor) setState((prev) => (prev.key === requestedFor ? { ...prev, error } : { key: requestedFor, data: undefined, error }));
    }
  }, []);

  // One loop per key: the key changing tears down the previous key's
  // polling/signal subscription and starts the new one.
  usePolling(reload, poll, key !== null, key);

  const mutate = useCallback((update: (prev: T | undefined) => T) => {
    const current = keyRef.current;
    setState((prev) => ({ key: current, data: update(prev.key === current ? prev.data : undefined), error: undefined }));
  }, []);

  return { data: state.key === key ? state.data : undefined, error: state.key === key ? state.error : undefined, reload, mutate };
}
