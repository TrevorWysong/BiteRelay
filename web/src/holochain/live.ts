// Chat and live driver location between an order's customer and its
// driver -- sent app to app as Holochain direct signals, never stored and
// never run through zome code (why: dispatch_coordinator::live).
//
// The network vouches for who sent a direct signal (`from_agent`), and
// nothing else: anyone can send this app any bytes. So each end asks its
// node once who its counterpart on an order is (`live_counterpart`), and
// checks every signal against that -- a chat line is passed on only from
// the order's other party, a location only from its driver to its
// customer. A signal that doesn't check out is dropped, quietly: screens
// poll, and chat was always best effort.
import { decode, encode } from "@msgpack/msgpack";
import type { DirectSignal } from "@holochain/client";
import { callZome, onDirectSignal, sendDirectSignal } from "./client";
import { bytesEqual, bytesToHex } from "./decode";
import { MAX_NOTE_CHARS } from "./types";
import type { ActionHash, AgentPubKey, LiveCounterpart, Timestamp } from "./types";
import { nowMicros } from "../lib/ui/format";

/// What a screen hears: checked, with `from` the network-verified sender
/// and `sent_at` when it arrived here.
export type LiveSignal =
  | { ChatMessage: { order_ref: ActionHash; from: AgentPubKey; text: string; sent_at: Timestamp } }
  | { LocationUpdate: { order_ref: ActionHash; lat: number; lon: number; sent_at: Timestamp } };

/// What travels: the sender's say-so, checked on arrival.
type Wire = { Chat: { order_ref: Uint8Array; text: string } } | { Location: { order_ref: Uint8Array; lat: number; lon: number } };

/// Who's on an order, as this node saw it a moment ago. A driver can be
/// released and another accepted, so an answer is read again after a
/// minute, or sooner when a signal doesn't match it.
const COUNTERPART_FRESH_MS = 60_000;
const RECHECK_AFTER_MS = 10_000;
/// Remembered orders, at most -- anyone can name any order, and each one
/// named costs this node a read.
const COUNTERPARTS_KEPT = 64;

interface Known {
  at: number;
  answer: Promise<LiveCounterpart>;
}
const counterparts = new Map<string, Known>();

function counterpart(orderRef: ActionHash, maxAgeMs = COUNTERPART_FRESH_MS): Promise<LiveCounterpart> {
  const key = bytesToHex(orderRef);
  const known = counterparts.get(key);
  if (known && Date.now() - known.at < maxAgeMs) return known.answer;
  const answer = callZome<LiveCounterpart>("dispatch", "live_counterpart", orderRef);
  counterparts.delete(key);
  counterparts.set(key, { at: Date.now(), answer });
  if (counterparts.size > COUNTERPARTS_KEPT) counterparts.delete(counterparts.keys().next().value!);
  return answer;
}

/// Sends a chat line to the order's other party. Refused, with the
/// network's reason, if the sender isn't on the order or it has no driver.
export async function sendChatMessage(orderRef: ActionHash, text: string): Promise<void> {
  const { counterpart: to } = await counterpart(orderRef);
  await sendDirectSignal([to], encode({ Chat: { order_ref: orderRef, text } } satisfies Wire));
}

/// Sends the driver's position to the order's customer -- only from its
/// driver; the client throttles how often (driver/Dashboard.tsx).
export async function sendLocationUpdate(orderRef: ActionHash, lat: number, lon: number): Promise<void> {
  const { counterpart: to, role } = await counterpart(orderRef);
  if (role !== "Driver") throw new Error("Only this order's driver can share a live location.");
  await sendDirectSignal([to], encode({ Location: { order_ref: orderRef, lat, lon } } satisfies Wire));
}

/// The wire form, if `bytes` is one -- every field checked, since anyone
/// could have sent them.
function parse(bytes: Uint8Array): Wire | null {
  let value: unknown;
  try {
    value = decode(bytes);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const chat = (value as { Chat?: unknown }).Chat as { order_ref?: unknown; text?: unknown } | undefined;
  if (chat && chat.order_ref instanceof Uint8Array && typeof chat.text === "string") {
    const text = chat.text;
    return text.trim() && [...text].length <= MAX_NOTE_CHARS ? { Chat: { order_ref: chat.order_ref, text } } : null;
  }
  const location = (value as { Location?: unknown }).Location as { order_ref?: unknown; lat?: unknown; lon?: unknown } | undefined;
  if (location && location.order_ref instanceof Uint8Array && typeof location.lat === "number" && typeof location.lon === "number") {
    const { lat, lon } = location;
    const plausible = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    return plausible ? { Location: { order_ref: location.order_ref, lat, lon } } : null;
  }
  return null;
}

/// Whether `from` may say `wire`, by this node's reading of the order.
async function allowed(wire: Wire, from: AgentPubKey): Promise<boolean> {
  const orderRef = "Chat" in wire ? wire.Chat.order_ref : wire.Location.order_ref;
  const fits = (on: LiveCounterpart) => bytesEqual(on.counterpart, from) && ("Chat" in wire || on.role === "Customer");
  try {
    if (fits(await counterpart(orderRef))) return true;
    // The driver may have changed since: look again, at most so often.
    return fits(await counterpart(orderRef, RECHECK_AFTER_MS));
  } catch {
    return false;
  }
}

const listeners = new Set<(signal: LiveSignal) => void>();
let stopListening: (() => void) | null = null;

async function receive({ from_agent: from, signal }: DirectSignal) {
  const wire = parse(signal);
  if (!wire || !(await allowed(wire, from))) return;
  const sent_at = nowMicros();
  const live: LiveSignal =
    "Chat" in wire
      ? { ChatMessage: { order_ref: wire.Chat.order_ref, from, text: wire.Chat.text, sent_at } }
      : { LocationUpdate: { order_ref: wire.Location.order_ref, lat: wire.Location.lat, lon: wire.Location.lon, sent_at } };
  for (const listener of listeners) listener(live);
}

/// Subscribes to checked chat and location signals. Nothing is checked --
/// or read -- while nobody's listening.
export function onLiveSignal(handler: (signal: LiveSignal) => void): () => void {
  listeners.add(handler);
  stopListening ??= onDirectSignal((signal) => void receive(signal));
  return () => {
    listeners.delete(handler);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = null;
    }
  };
}
