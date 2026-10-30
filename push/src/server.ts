// The relay's HTTP face, for the app:
//
//   GET    /config                               -> {channels, vapidPublicKey}
//   POST   /devices          {channel, address}  -> {device, secret, tokens}
//   POST   /devices/tokens   {device, secret}    -> {tokens}   (a fresh batch)
//   DELETE /devices          {device, secret}    -> {}         (forget it)
//   POST   /wake             {token}             -> {}         (always the same)
//   GET    /health
//
// A device registers once and gets wake tokens in batches, to hand one to
// each party that should be able to wake it about an order (docs/MOBILE.md). A
// wake names only a token: the relay learns that some device was woken,
// not who asked or about what, and answers every wake alike so nobody can
// use it to test a token. Each device is woken a few times a minute at
// most, and so often a day.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Outcome, Sender } from "./channels/channel.ts";
import type { Channel, Store } from "./store.ts";
import { mintToken, openToken } from "./tokens.ts";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_ADDRESS_CHARS = 4 * 1024;
const TOKENS_PER_BATCH = 20;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface Deps {
  store: Store;
  /// The relay's token key: 32 bytes.
  tokenKey: Buffer;
  /// The channels this relay delivers on.
  senders: Partial<Record<Channel, Sender>>;
  vapidPublicKey: string | null;
  /// How long a token works for, from when it's made.
  tokenTtlMs: number;
  wakesPerMinute: number;
  wakesPerDay: number;
  /// Registrations and token batches one address may ask for an hour.
  requestsPerIpPerHour: number;
  appOrigins: string[];
  trustProxy: boolean;
  log?: (message: string) => void;
  /// Called once a wake has been delivered or given up on -- for tests.
  onWake?: (outcome: Outcome | "dropped") => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Falls through.
  }
  throw new HttpError(400, "Send a JSON object.");
}

function text(value: unknown, what: string, max = 200): string {
  if (typeof value !== "string" || !value || value.length > max) throw new HttpError(400, `Which ${what}?`);
  return value;
}

export function handler(deps: Deps) {
  const { store, tokenKey, senders, log = () => {}, onWake = () => {} } = deps;
  const channels = Object.keys(senders) as Channel[];

  /// When each device was last woken, for its limits. Kept in memory: a
  /// restart forgets it, which only ever loosens a limit for a while.
  const wokenAt = new Map<string, number[]>();
  function mayWake(device: string): boolean {
    const now = Date.now();
    const recent = (wokenAt.get(device) ?? []).filter((at) => at > now - DAY_MS);
    if (recent.length >= deps.wakesPerDay || recent.filter((at) => at > now - MINUTE_MS).length >= deps.wakesPerMinute) return false;
    wokenAt.set(device, [...recent, now]);
    return true;
  }

  const requestsByAddress = new Map<string, number[]>();
  let swept = Date.now();
  function throttle(req: IncomingMessage) {
    const now = Date.now();
    if (now - swept > HOUR_MS) {
      for (const [address, times] of requestsByAddress) if (times.every((at) => at <= now - HOUR_MS)) requestsByAddress.delete(address);
      for (const [device, times] of wokenAt) if (times.every((at) => at <= now - DAY_MS)) wokenAt.delete(device);
      swept = now;
    }
    const forwarded = deps.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    const address = forwarded || req.socket.remoteAddress || "unknown";
    const recent = (requestsByAddress.get(address) ?? []).filter((at) => at > now - HOUR_MS);
    if (recent.length >= deps.requestsPerIpPerHour) throw new HttpError(429, "Too many requests from here. Try again later.");
    requestsByAddress.set(address, [...recent, now]);
  }

  const batch = (device: string) => {
    const expiresAt = Date.now() + deps.tokenTtlMs;
    return Array.from({ length: TOKENS_PER_BATCH }, () => mintToken(tokenKey, { device, expiresAt }));
  };

  function authenticated(body: Record<string, unknown>) {
    const device = store.authenticate(text(body.device, "device"), text(body.secret, "secret"));
    if (!device) throw new HttpError(404, "This device isn't registered here. Register it again.");
    return device;
  }

  /// Delivers a wake in the background: whoever asked learns nothing of
  /// what became of it.
  async function wake(token: string) {
    const opened = openToken(tokenKey, token);
    const device = opened && opened.expiresAt > Date.now() ? store.device(opened.device) : null;
    const sender = device && senders[device.channel];
    if (!device || !sender || !mayWake(device.id)) return onWake("dropped");
    let outcome: Outcome;
    try {
      outcome = await sender.send(device.address);
    } catch (err) {
      log(`a ${device.channel} wake failed: ${err instanceof Error ? err.message : String(err)}`);
      outcome = "failed";
    }
    if (outcome === "gone") store.forget(device.id);
    onWake(outcome);
  }

  const routes: Record<string, (req: IncomingMessage) => Promise<unknown>> = {
    "GET /health": async () => ({ ok: true }),
    "GET /config": async () => ({ channels, vapidPublicKey: deps.vapidPublicKey }),
    "POST /devices": async (req) => {
      throttle(req);
      const body = await json(req);
      const channel = text(body.channel, "channel") as Channel;
      if (!channels.includes(channel)) throw new HttpError(400, "This relay doesn't deliver that way.");
      const { id, secret } = store.register(channel, text(body.address, "address", MAX_ADDRESS_CHARS));
      return { device: id, secret, tokens: batch(id) };
    },
    "POST /devices/tokens": async (req) => {
      throttle(req);
      return { tokens: batch(authenticated(await json(req)).id) };
    },
    "DELETE /devices": async (req) => {
      store.forget(authenticated(await json(req)).id);
      return {};
    },
    "POST /wake": async (req) => {
      const token = (await json(req)).token;
      if (typeof token === "string" && token.length <= 512) void wake(token);
      return {};
    },
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && deps.appOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const route = routes[`${req.method} ${(req.url ?? "").split("?")[0]}`];
    try {
      if (!route) throw new HttpError(404, "Not found.");
      const result = await route(req);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`error: ${err instanceof Error ? err.stack : String(err)}`);
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: status === 500 ? "Something went wrong. Try again." : (err as Error).message }));
    }
  };
}

export function serve(deps: Deps, port: number) {
  return createServer(handler(deps)).listen(port);
}
