// The app's two data-sync primitives, so no screen hand-rolls an effect for
// "a response arrived for something we've moved away from" or "tear down
// the interval and signal subscription". They're effects on purpose --
// reading, polling and listening to the conductor is syncing with an
// external system -- but they live here, once.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { onLocalSignal } from "../holochain/client";
import { onLiveSignal, type LiveSignal } from "../holochain/live";
import type { LocalSignal } from "../holochain/types";

interface PollOptions {
  /// Re-run on this cadence while mounted and visible -- see `POLL` for the
  /// cadences. Every signal-driven screen must also poll: signals are a fast
  /// path, never a delivery guarantee (see `onLocalSignal`'s doc comment).
  pollMs?: number;
  /// Re-run immediately when a matching conductor signal arrives.
  refreshOn?: (signal: LocalSignal) => boolean;
  /// Keep polling while the tab is hidden -- for duties, not displays: a
  /// driver's presence beacon, firing a recurring order.
  background?: boolean;
}

/// A ref that always holds the latest `value` -- for a callback that must
/// stay the same function (an interval's, a camera's) yet use the latest
/// props. Refreshed after every render, before any effect or event handler
/// can read it -- never written during render itself, which concurrent
/// rendering may discard.
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/// Runs `run` now, on every `pollMs` tick, and on every matching signal,
/// for as long as `enabled` holds -- the polling-plus-signal loop that
/// several screens otherwise duplicate. `run` always calls the *latest*
/// function passed in (kept in a ref), so callers don't need `useCallback`
/// gymnastics to avoid tearing the interval down on every render.
/// `restartKey` changing restarts the loop (and runs immediately) -- pass
/// whatever identifies *what* is being polled, so moving to a different
/// one fetches it straight away instead of waiting for the next tick.
export function usePolling(run: () => unknown, { pollMs, refreshOn, background = false }: PollOptions, enabled = true, restartKey?: string | null) {
  const runRef = useLatest(run);
  const filterRef = useLatest(refreshOn);
  const hasSignalFilter = !!refreshOn;

  useEffect(() => {
    if (!enabled) return;
    // One read at a time: a tick while one is in flight just asks for
    // another once it's done, so a burst of signals costs one extra read,
    // not one per signal.
    let running = false;
    let again = false;
    const tick = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await runRef.current();
        } while (again);
      } finally {
        running = false;
      }
    };
    void tick();
    // Display polls skip while the tab is hidden, and catch up the moment
    // it's back; background duties keep going.
    const visible = () => background || document.visibilityState === "visible";
    const interval = pollMs ? setInterval(() => visible() && void tick(), pollMs) : null;
    const onVisible = () => visible() && void tick();
    if (pollMs) document.addEventListener("visibilitychange", onVisible);
    const unsub = hasSignalFilter ? onLocalSignal((s) => filterRef.current?.(s) && void tick()) : null;
    return () => {
      if (interval) clearInterval(interval);
      if (pollMs) document.removeEventListener("visibilitychange", onVisible);
      unsub?.();
    };
  }, [enabled, pollMs, hasSignalFilter, restartKey, background, runRef, filterRef]);
}

/// Calls `handler` with every conductor signal while mounted (and while
/// `enabled`) -- for reacting to what a signal says, not just refreshing a
/// read. The latest `handler` is always the one called.
export function useLocalSignal(handler: (signal: LocalSignal) => void, enabled = true) {
  const handlerRef = useLatest(handler);
  useEffect(() => {
    if (!enabled) return;
    return onLocalSignal((signal) => handlerRef.current(signal));
  }, [enabled, handlerRef]);
}

/// Calls `handler` with every checked chat line and driver location while
/// mounted (and while `enabled`) -- see `holochain/live.ts`.
export function useLiveSignal(handler: (signal: LiveSignal) => void, enabled = true) {
  const handlerRef = useLatest(handler);
  useEffect(() => {
    if (!enabled) return;
    return onLiveSignal((signal) => handlerRef.current(signal));
  }, [enabled, handlerRef]);
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
