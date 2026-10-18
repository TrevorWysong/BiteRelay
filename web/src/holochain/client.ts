// The connection to a real Holochain conductor's App API -- there is no
// central server here. Production connects through its launcher
// (`connectLauncher`); development, with a token the dev host issued
// (`connect`) -- see `host.ts`. This module owns exactly one AppWebsocket at
// a time; every zome call in the app goes through `callZome` below, which
// resolves against the "relay" DNA role by name rather than a
// manually-tracked cell_id, since a browser client has no admin-level cell
// enumeration of its own.
//
// The connection heals itself. A socket can drop at any time -- the browser
// suspends a background tab, a laptop sleeps, the conductor restarts -- and
// the client library's own reconnect reuses its first token, which is
// single-use, so it can't. Instead, whoever connected registers how to
// connect again (`setRestorer`): the dev host asks its node for a fresh
// token, a launcher hands over its connection again. Calls that never
// reached the conductor are retried once the connection is back; a call cut
// off mid-flight isn't (it may have run), and says so. Signal listeners
// carry over to each new socket.
import { AppWebsocket } from "@holochain/client";
import type { AppAuthenticationToken, Signal, WsClientOptions } from "@holochain/client";
import type { LocalSignal } from "./types";

const ROLE_NAME = "relay";

export type ConnectParams = {
  url: string; // e.g. "ws://localhost:8888"
  token: Uint8Array; // issued once, out-of-band, by whatever installed the app for this agent
  /// Never needed from a real browser (browsers send Origin automatically,
  /// matching whatever the conductor's app interface was attached with) --
  /// exists so non-browser callers (this app's own test/verification
  /// scripts, run under Node) can supply one explicitly.
  wsClientOptions?: WsClientOptions;
};

let appWs: AppWebsocket | null = null;

/// Every `onLocalSignal` listener, so each socket the app opens hears them.
const signalListeners = new Set<(signal: LocalSignal) => void>();
function deliverSignal(signal: Signal) {
  if (signal.type !== "app") return;
  for (const listener of signalListeners) listener(signal.value.payload as LocalSignal);
}

/// Makes `ws` the app's connection, with every signal listener on it.
function install(ws: AppWebsocket): AppWebsocket {
  appWs = ws;
  ws.on("signal", deliverSignal);
  setState("connected");
  return ws;
}

export async function connect({ url, token, wsClientOptions }: ConnectParams): Promise<AppWebsocket> {
  return install(await openSocket({ url, token, wsClientOptions }));
}

/// A new socket to the conductor at `url`, authenticated with `token`.
export function openSocket({ url, token, wsClientOptions }: ConnectParams): Promise<AppWebsocket> {
  return AppWebsocket.connect({ url: new URL(url), token: token as unknown as AppAuthenticationToken, wsClientOptions });
}

/// Connects through the runtime hosting this app (see `host.ts`): it
/// provides the app and its connection, and signs every zome call, so
/// there's nothing to pass.
export async function connectLauncher(): Promise<AppWebsocket> {
  setRestorer(() => AppWebsocket.connect());
  return install(await AppWebsocket.connect());
}

export function getAppWs(): AppWebsocket {
  if (!appWs) throw new Error("not connected to a conductor yet");
  return appWs;
}

export function isConnected(): boolean {
  return appWs !== null;
}

// --- healing the connection ---

/// Whether the app can reach its conductor: connected, getting a new
/// connection, or out of attempts until someone retries.
export type ConnectionState = "connected" | "restoring" | "lost";

let state: ConnectionState = "connected";
const stateListeners = new Set<() => void>();
function setState(next: ConnectionState) {
  if (state === next) return;
  state = next;
  for (const listener of stateListeners) listener();
}

/// For `useSyncExternalStore`: the current state, and a way to hear it change.
export const connectionState = {
  get: (): ConnectionState => state,
  subscribe(listener: () => void): () => void {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  },
};

let restorer: (() => Promise<AppWebsocket>) | null = null;
let restoring: Promise<void> | null = null;

/// How to open a new connection as the signed-in agent -- set by whoever
/// connected. It must not ask the person anything (no passkey prompt): they
/// already unlocked this visit.
export function setRestorer(restore: (() => Promise<AppWebsocket>) | null) {
  restorer = restore;
}

const RESTORE_DELAYS_MS = [0, 1000, 3000, 8000];

/// Opens a new connection, once however many calls need it, retrying with
/// backoff -- `lost` if every attempt fails, until `retryConnection`.
function restoreConnection(): Promise<void> {
  if (!restorer) return Promise.reject(new Error("Lost the connection to your node. Reload the page."));
  restoring ??= (async () => {
    setState("restoring");
    try {
      let lastError: unknown;
      for (const delay of RESTORE_DELAYS_MS) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        try {
          install(await restorer!());
          return;
        } catch (err) {
          lastError = err;
        }
      }
      setState("lost");
      throw lastError;
    } finally {
      restoring = null;
    }
  })();
  return restoring;
}

/// Tries again after the connection was given up on -- the banner's Retry.
export function retryConnection(): Promise<void> {
  return restoreConnection();
}

/// The client's errors for a call that never reached the conductor -- safe
/// to send again once connected. (Its `ClientClosedWithPendingRequests`,
/// for a call cut off mid-flight, is deliberately not among them.)
const NOT_SENT = /WebsocketClosedError|InvalidTokenError|ConnectionError|Websocket is not open|could not connect/;
const CUT_OFF = /ClientClosedWithPendingRequests|client closed with pending requests/;

/// Holochain's messages for a commit refused before anything was written,
/// so the call is safe to repeat:
///   - its validation needed a record that hasn't reached this node yet
///     (`DepMissingFromDht`) -- typical right after someone else's write,
///     e.g. ordering from a menu edited a moment ago;
///   - this node's own background work (a store's auto-accept, an order's
///     upkeep) wrote to the same chain while the call ran.
const RETRYABLE = /could not be completed but may be retried|source chain head has moved/;
const RETRY_DELAYS_MS = [500, 1500, 3000];

export async function callZome<T>(zomeName: string, fnName: string, payload?: unknown): Promise<T> {
  return callZomeIn(ROLE_NAME, zomeName, fnName, payload);
}

/// The app role that carries the previous version of the network, in a
/// release made while people move from it (MIGRATION.md).
export const PREVIOUS_ROLE = "previous";

/// A zome call on the previous version of the network -- only in a release
/// that carries it (`hasPreviousNetwork`).
export async function callPrevious<T>(zomeName: string, fnName: string, payload?: unknown): Promise<T> {
  return callZomeIn(PREVIOUS_ROLE, zomeName, fnName, payload);
}

let previousNetwork: Promise<boolean> | null = null;

/// Whether this release carries the previous version of the network.
export function hasPreviousNetwork(): Promise<boolean> {
  previousNetwork ??= getAppWs()
    .appInfo()
    .then((info) => (info?.cell_info[PREVIOUS_ROLE] ?? []).length > 0)
    .catch(() => {
      previousNetwork = null;
      return false;
    });
  return previousNetwork;
}

async function callZomeIn<T>(roleName: string, zomeName: string, fnName: string, payload?: unknown): Promise<T> {
  const request = { role_name: roleName, zome_name: zomeName, fn_name: fnName, payload };
  let reconnected = false;
  for (let attempt = 0; ; attempt++) {
    // A call made while a new connection is on its way waits for it.
    if (restoring) await restoring.catch(() => {});
    try {
      return await getAppWs().callZome<T>(request);
    } catch (err) {
      const message = String((err as Error)?.message ?? err) + String((err as Error)?.name ?? "");
      if (NOT_SENT.test(message) && !reconnected) {
        reconnected = true;
        await restoreConnection();
        attempt--;
        continue;
      }
      if (CUT_OFF.test(message)) {
        void restoreConnection().catch(() => {});
        throw new Error("The connection to your node dropped mid-request. Check whether it went through, then try again.");
      }
      if (attempt >= RETRY_DELAYS_MS.length || !RETRYABLE.test(message)) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

export function myAgentPubKey(): Uint8Array {
  return getAppWs().myPubKey;
}

/// Subscribes to `dispatch`'s fire-and-forget `LocalSignal`s (see plan §3 --
/// this is Layer 2's fast path, never the sole guarantee). Every screen
/// that relies on a signal must *also* poll the corresponding DHT read on
/// its own cadence; this is a UX accelerant, not a delivery guarantee --
/// see `HOLOCHAIN_ISSUES.md` #1 for the measured, real reason why. Holds
/// across reconnections.
export function onLocalSignal(handler: (signal: LocalSignal) => void): () => void {
  signalListeners.add(handler);
  return () => signalListeners.delete(handler);
}
