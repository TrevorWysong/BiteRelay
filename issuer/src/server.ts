// The service's HTTP face, for the app and for Stripe:
//
//   GET  /config                                        -> {publishableKey}
//   POST /nonce                {agent}                  -> {nonce, issuer}
//   POST /topups               signed TopUp, {amount}   -> {clientSecret}  (embedded card form)
//   POST /saved-card           signed SavedCard         -> {card}          (brand and last 4, or null)
//   POST /saved-card/charge    signed SavedCard, {amount} -> {paid} | {needsConfirmation}
//   POST /payout-account       signed PayoutAccount     -> {url}           (Stripe onboarding)
//   POST /webhooks/stripe      Stripe's signed events   -> grants completed payments, freezes disputed accounts
//   GET  /health
//
// A signed request carries {agent, nonce, signature}: the agent signed the
// service's one-time nonce for that purpose (see link.ts). Nothing here
// moves money on anyone's word: a grant follows only a payment Stripe
// confirms, and only the agent themselves can save a card to their account,
// pay with it, or link where their payouts go. How much card money an
// account may add is the issuer's risk policy (risk.ts).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { agentId, agentKey, type IssuerLedger } from "./ledger.ts";
import { newNonce, verifyLink, type Purpose } from "./link.ts";
import type { PaymentRail } from "./rail.ts";
import { topUpRefusal, type RiskPolicy } from "./risk.ts";
import type { Store } from "./store.ts";
import { grantPayment } from "./topups.ts";

/// Card payments, each: at least enough to be worth the card fee, at most
/// well under the closed-loop prepaid limit of $2,000 a day.
const MIN_TOPUP_CENTS = 500;
const MAX_TOPUP_CENTS = 50_000;
/// Saved-card charges an agent may make in a day -- auto top-up included.
const SAVED_CARD_CHARGES_PER_DAY = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
/// How long a nonce stays good.
const NONCE_MAX_AGE_MS = 10 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface Deps {
  store: Store;
  ledger: IssuerLedger;
  rail: PaymentRail;
  /// The origins the app runs at, allowed to call this from inside it.
  appOrigins: string[];
  /// Stripe's publishable key, for the app's embedded card form.
  publishableKey: string;
  policy: RiskPolicy;
  /// Card forms one address may open an hour.
  topUpsPerIpPerHour: number;
  /// Whether to read the caller's address from X-Forwarded-For (behind a proxy).
  trustProxy: boolean;
  format: (cents: number) => string;
  log?: (message: string) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse((await body(req)).toString("utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Falls through.
  }
  throw new HttpError(400, "Send a JSON object.");
}

/// An agent id from a request, checked to be a real agent key.
function agentFrom(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "Which agent?");
  try {
    const key = agentKey(value);
    if (key.length !== 39) throw new Error();
    return agentId(key);
  } catch {
    throw new HttpError(400, "That isn't an agent key.");
  }
}

/// An amount in cents a card may pay.
function amountFrom(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_TOPUP_CENTS || value > MAX_TOPUP_CENTS) {
    throw new HttpError(400, `Pay between ${MIN_TOPUP_CENTS / 100} and ${MAX_TOPUP_CENTS / 100} dollars at a time.`);
  }
  return value;
}

const HOUR_MS = 60 * 60 * 1000;

export function handler(deps: Deps) {
  const { store, ledger, rail, appOrigins, publishableKey, policy, format, log = () => {} } = deps;
  /// When each address opened its recent card forms -- kept in memory: a
  /// restart forgets them, which only ever loosens this, never the limits.
  const formsByAddress = new Map<string, number[]>();

  /// Refuses an address that's opened too many card forms this hour --
  /// someone testing stolen cards opens many.
  function throttle(req: IncomingMessage) {
    const forwarded = deps.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    const address = forwarded || req.socket.remoteAddress || "unknown";
    const recent = (formsByAddress.get(address) ?? []).filter((at) => at > Date.now() - HOUR_MS);
    if (recent.length >= deps.topUpsPerIpPerHour) throw new HttpError(429, "Too many card payments from here. Try again later.");
    formsByAddress.set(address, [...recent, Date.now()]);
  }

  /// Refuses `amount` if it's more than `agent` may add now.
  async function checkRoom(agent: string, amount: number) {
    const refusal = topUpRefusal(store, agent, amount, await ledger.standingOf(agentKey(agent)), policy, format);
    if (refusal) throw new HttpError(429, refusal);
  }

  /// The agent a signed request is from, for `purpose` -- or why not.
  function signedBy(input: Record<string, unknown>, purpose: Purpose): string {
    const agent = agentFrom(input.agent);
    const { nonce, signature } = input;
    if (typeof nonce !== "string" || typeof signature !== "string") throw new HttpError(400, "Send the nonce and your signature.");
    if (!store.takeNonce(nonce, agent, NONCE_MAX_AGE_MS)) throw new HttpError(401, "That request has expired. Try again.");
    if (!verifyLink(agentKey(agent), purpose, ledger.issuer, nonce, Buffer.from(signature, "base64"))) throw new HttpError(401, "That signature isn't yours.");
    return agent;
  }

  /// The agent's customer record at the processor, made on first use.
  async function customerOf(agent: string): Promise<string> {
    const existing = store.customer(agent);
    const customer = await rail.customer(agent, existing);
    if (!existing) store.setCustomer(agent, customer);
    return customer;
  }

  const routes: Record<string, (req: IncomingMessage) => Promise<unknown>> = {
    "GET /health": async () => ({ ok: true }),

    "GET /config": async () => ({ publishableKey }),

    "POST /nonce": async (req) => {
      const agent = agentFrom((await json(req)).agent);
      const nonce = newNonce();
      store.issueNonce(nonce, agent);
      return { nonce, issuer: agentId(ledger.issuer) };
    },

    "POST /topups": async (req) => {
      const input = await json(req);
      const agent = signedBy(input, "TopUp");
      const amount = amountFrom(input.amount);
      throttle(req);
      await checkRoom(agent, amount);
      const clientSecret = await rail.embeddedTopUp(agent, await customerOf(agent), amount, { verify: !store.hasPaidBefore(agent) });
      store.recordTopUpAttempt(agent, amount);
      return { clientSecret };
    },

    "POST /saved-card": async (req) => {
      const agent = signedBy(await json(req), "SavedCard");
      const customer = store.customer(agent);
      return { card: customer ? await rail.savedCard(customer) : null };
    },

    "POST /saved-card/charge": async (req) => {
      const input = await json(req);
      const agent = signedBy(input, "SavedCard");
      const amount = amountFrom(input.amount);
      const customer = store.customer(agent);
      if (!customer) throw new HttpError(409, "There's no saved card yet. Pay with the card form once.");
      await checkRoom(agent, amount);
      if (!store.takeSavedCardCharge(agent, SAVED_CARD_CHARGES_PER_DAY, DAY_MS)) throw new HttpError(429, "That's as many saved-card payments as one day allows. Use the card form.");
      store.recordTopUpAttempt(agent, amount);
      // The nonce is single-use, so it keys the charge: retrying this request
      // can't charge twice.
      const charge = await rail.chargeSavedCard(agent, customer, amount, `saved-card-${input.nonce as string}`);
      if ("needsConfirmation" in charge) return { needsConfirmation: true };
      // Granted now, rather than waiting on a webhook: the money is in.
      const result = await grantPayment(store, ledger, charge.paid);
      log(`${result} (saved card): ${charge.paid.payment}, ${amount} for ${agent}`);
      return { paid: true };
    },

    "POST /payout-account": async (req) => {
      const agent = signedBy(await json(req), "PayoutAccount");
      const { account, url } = await rail.payoutAccountLink(agent, store.payoutAccount(agent));
      store.setPayoutAccount(agent, account);
      return { url };
    },

    "POST /webhooks/stripe": async (req) => {
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string") throw new HttpError(400, "Unsigned.");
      let event;
      try {
        event = await rail.event(await body(req), signature);
      } catch {
        throw new HttpError(400, "That isn't a genuine event.");
      }
      if (!event) return { ignored: true };
      if (event.kind === "paid") {
        const result = await grantPayment(store, ledger, event.payment);
        log(`${result}: ${event.payment.payment}, ${event.payment.amount} for ${event.payment.agent}`);
        return { result };
      }
      const agent = store.agentOfPayment(event.payment);
      if (!agent) return { ignored: true };
      if (event.kind === "disputed") {
        // Card money that may not have been theirs: nothing more in or out
        // until it's settled.
        store.openDispute(event.payment, agent, event.amount);
        log(`dispute on ${event.payment} (${event.amount}): froze ${agent}`);
      } else {
        store.closeDispute(event.payment, event.won);
        log(`dispute on ${event.payment} ${event.won ? "won: unfroze" : "lost: stays frozen for review:"} ${agent}`);
      }
      return { result: event.kind };
    },
  };

  /// The pages Stripe sends someone to after setting up their payout
  /// account -- the app itself has no web address to return to.
  const pages: Record<string, string> = {
    "GET /payouts/done": "Your payout account is set up. Go back to Relay: your cash-outs are paid to it from now on.",
    "GET /payouts/expired": "That link has expired. Go back to Relay and open Wallet → Payout account again.",
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const page = pages[`${req.method} ${(req.url ?? "").split("?")[0]}`];
    if (page) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay</title><body style="font:16px system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center"><h1>Relay</h1><p>${page}</p></body>`,
      );
      return;
    }
    // The app calls from the browser; nothing else may.
    const origin = req.headers.origin;
    if (origin && appOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Vary", "Origin");
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
