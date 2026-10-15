// The service's HTTP face, for the app and for Stripe:
//
//   GET  /config                                        -> {publishableKey}
//   POST /nonce                {agent}                  -> {nonce, issuer}
//   POST /topups               signed TopUp, {amount}   -> {clientSecret}  (embedded card form)
//   POST /saved-card           signed SavedCard         -> {card}          (brand and last 4, or null)
//   POST /saved-card/charge    signed SavedCard, {amount} -> {paid} | {needsConfirmation}
//   POST /payout-account       signed PayoutAccount     -> {url}           (Stripe onboarding)
//   POST /webhooks/stripe      Stripe's signed events   -> grants completed payments
//   GET  /health
//
// A signed request carries {agent, nonce, signature}: the agent signed the
// service's one-time nonce for that purpose (see link.ts). Nothing here
// moves money on anyone's word: a grant follows only a payment Stripe
// confirms, and only the agent themselves can save a card to their account,
// pay with it, or link where their payouts go.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { agentId, agentKey, type IssuerLedger } from "./ledger.ts";
import { newNonce, verifyLink, type Purpose } from "./link.ts";
import type { PaymentRail } from "./rail.ts";
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
  /// The app's origin, allowed to call this from the browser.
  appOrigin: string;
  /// Stripe's publishable key, for the app's embedded card form.
  publishableKey: string;
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

export function handler(deps: Deps) {
  const { store, ledger, rail, appOrigin, publishableKey, log = () => {} } = deps;

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
      return { clientSecret: await rail.embeddedTopUp(agent, await customerOf(agent), amount) };
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
      if (!store.takeSavedCardCharge(agent, SAVED_CARD_CHARGES_PER_DAY, DAY_MS)) throw new HttpError(429, "That's as many saved-card payments as one day allows. Use the card form.");
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
      let payment;
      try {
        payment = await rail.completedPayment(await body(req), signature);
      } catch {
        throw new HttpError(400, "That isn't a genuine event.");
      }
      if (!payment) return { ignored: true };
      const result = await grantPayment(store, ledger, payment);
      log(`${result}: ${payment.payment}, ${payment.amount} for ${payment.agent}`);
      return { result };
    },
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    // The app calls from the browser; nothing else may.
    if (req.headers.origin === appOrigin) {
      res.setHeader("Access-Control-Allow-Origin", appOrigin);
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
