// The connection to a real Holochain conductor's App API -- there is no
// central server here. This module owns exactly one AppWebsocket instance;
// every zome call in the app goes through `callZome` below, which resolves
// against the "relay" DNA role by name rather than a manually-tracked
// cell_id, since a browser client has no admin-level cell enumeration of
// its own.
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

export async function connect({ url, token, wsClientOptions }: ConnectParams): Promise<AppWebsocket> {
  appWs = await AppWebsocket.connect({
    url: new URL(url),
    token: token as unknown as AppAuthenticationToken,
    wsClientOptions,
  });
  return appWs;
}

export function getAppWs(): AppWebsocket {
  if (!appWs) throw new Error("not connected to a conductor yet");
  return appWs;
}

export function isConnected(): boolean {
  return appWs !== null;
}

export async function callZome<T>(zomeName: string, fnName: string, payload?: unknown): Promise<T> {
  const ws = getAppWs();
  return ws.callZome<T>({
    role_name: ROLE_NAME,
    zome_name: zomeName,
    fn_name: fnName,
    payload,
  });
}

export function myAgentPubKey(): Uint8Array {
  return getAppWs().myPubKey;
}

/// Subscribes to `dispatch`'s fire-and-forget `LocalSignal`s (see plan §3 --
/// this is Layer 2's fast path, never the sole guarantee). Every screen
/// that relies on a signal must *also* poll the corresponding DHT read on
/// its own cadence; this is a UX accelerant, not a delivery guarantee --
/// see `HOLOCHAIN_ISSUES.md` #1 for the measured, real reason why.
export function onLocalSignal(handler: (signal: LocalSignal) => void): () => void {
  const ws = getAppWs();
  return ws.on("signal", (signal: Signal) => {
    if (signal.type !== "app") return;
    handler(signal.value.payload as LocalSignal);
  });
}

// Base64 helpers -- connection tokens and pasted agent keys travel as plain
// text (a URL param, a manually-copied dev value), never as raw bytes.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
