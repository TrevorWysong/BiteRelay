// Waking this app when it's closed (docs/MOBILE.md, "Waking a closed app"): the
// network's push relay (`push/`, its `services.push_relay_url`) holds how to
// reach this device, and hands it wake tokens that name it to nobody else.
// Each order carries two of them, sealed: one for the store, one for the
// driver, who hand theirs to the relay when the order changes. The relay
// sends a push with nothing in it; what the person sees is built here.
//
// How the device is reached is the runtime's: a phone app's runtime hands
// over its APNs or FCM token as `window.__RELAY_PUSH__`; in a browser it's
// a Web Push subscription, through the service worker (public/sw.js).
import { useNetwork } from "../../store/network";
import { forget, readStoredJson, store } from "../util/storage";

/// What a phone app's runtime provides: the platform's push token for this
/// install, after asking the person's permission.
export interface PushRuntime {
  register(): Promise<{ channel: "apns" | "fcm"; address: string }>;
}

declare global {
  interface Window {
    __RELAY_PUSH__?: PushRuntime;
  }
}

interface Registration {
  relay: string;
  device: string;
  secret: string;
  tokens: string[];
}

const KEY = "relay.push";
/// Fetch a new batch before the last few are handed out.
const REFILL_BELOW = 8;

const registration = () => readStoredJson<Registration>(KEY);

/// The relay the network runs, if any.
function relayUrl(): string | null {
  return useNetwork.getState().terms?.push_relay_url?.replace(/\/$/, "") ?? null;
}

function webPushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window;
}

/// Whether this device can be woken while closed: the network runs a relay,
/// and the runtime or browser can receive its pushes.
export function canWakeWhileClosed(): boolean {
  return !!relayUrl() && (!!window.__RELAY_PUSH__ || webPushSupported());
}

/// Whether this device is set up to be woken through the network's relay.
export function wakesWhileClosed(): boolean {
  const current = registration();
  return !!current && current.relay === relayUrl();
}

async function post<T>(url: string, body: unknown, method = "POST"): Promise<T> {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(answer.error ?? `The push relay answered ${response.status}.`), { status: response.status });
  return answer;
}

/// Registers this device with the network's relay: asks for permission
/// (the runtime's, or the browser's), then where the relay reaches it.
export async function startWakingWhileClosed(): Promise<void> {
  const relay = relayUrl();
  if (!relay) throw new Error("This network doesn't run a push relay.");
  let target: { channel: string; address: string };
  if (window.__RELAY_PUSH__) {
    target = await window.__RELAY_PUSH__.register();
  } else {
    const { vapidPublicKey } = (await (await fetch(`${relay}/config`)).json()) as { vapidPublicKey: string | null };
    if (!vapidPublicKey) throw new Error("This network's push relay doesn't reach browsers.");
    if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this site.");
    const worker = await navigator.serviceWorker.ready;
    const subscription = (await worker.pushManager.getSubscription()) ?? (await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesFromBase64Url(vapidPublicKey) }));
    target = { channel: "webpush", address: JSON.stringify(subscription) };
  }
  const { device, secret, tokens } = await post<{ device: string; secret: string; tokens: string[] }>(`${relay}/devices`, target);
  store(KEY, JSON.stringify({ relay, device, secret, tokens } satisfies Registration));
}

/// Has the relay forget this device: every token it handed out stops working.
export async function stopWakingWhileClosed(): Promise<void> {
  const current = registration();
  forget(KEY);
  if (!current) return;
  await post(`${current.relay}/devices`, { device: current.device, secret: current.secret }, "DELETE").catch(() => {});
  if (!window.__RELAY_PUSH__ && webPushSupported()) {
    await (await navigator.serviceWorker.ready).pushManager.getSubscription().then((s) => s?.unsubscribe()).catch(() => {});
  }
}

let refilling: Promise<void> | null = null;

/// Fetches a new batch of tokens -- or, if the relay has forgotten this
/// device, stops waking it (the settings switch then shows off).
function refill(current: Registration) {
  refilling ??= post<{ tokens: string[] }>(`${current.relay}/devices/tokens`, { device: current.device, secret: current.secret })
    .then(({ tokens }) => {
      const latest = registration();
      if (latest?.device === current.device) store(KEY, JSON.stringify({ ...latest, tokens: [...latest.tokens, ...tokens] }));
    })
    .catch((err: { status?: number }) => {
      if (err.status === 404) forget(KEY);
    })
    .finally(() => (refilling = null));
}

/// Wake tokens for a new order -- one for its store, one for its driver --
/// or none, when this device isn't set up to be woken. Each token is used
/// once: two orders' tokens don't look alike.
export function wakeTokensForOrder(): { wake_for_store: string | null; wake_for_driver: string | null } {
  const current = registration();
  if (!current || current.relay !== relayUrl() || current.tokens.length < 2) {
    if (current) refill(current);
    return { wake_for_store: null, wake_for_driver: null };
  }
  const [forStore, forDriver, ...rest] = current.tokens;
  store(KEY, JSON.stringify({ ...current, tokens: rest }));
  if (rest.length < REFILL_BELOW) refill({ ...current, tokens: rest });
  return { wake_for_store: forStore, wake_for_driver: forDriver };
}

/// Wakes a customer whose order this store or driver just changed, with
/// the token their order gave us. Best-effort: they'll see it when they
/// next open the app regardless.
export function wakeCustomer(token: string): void {
  const relay = relayUrl();
  if (!relay) return;
  void fetch(`${relay}/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }).catch(() => {});
}

/// What the service worker shows when a wake arrives, in this person's
/// language: it has no way to read the order, so it says only that
/// something changed.
export function teachServiceWorker(words: { title: string; body: string }): void {
  if (!webPushSupported()) return;
  void navigator.serviceWorker.ready.then((worker) => worker.active?.postMessage({ type: "wake-words", ...words })).catch(() => {});
}

function bytesFromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
