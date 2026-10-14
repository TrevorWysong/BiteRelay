// The service's HTTP face, for the app and for Stripe:
//
//   POST /topups                 {agent, amount}            -> {url}  (Stripe Checkout)
//   POST /webhooks/stripe        Stripe's signed events     -> grants completed payments
//   POST /payout-account/nonce   {agent}                    -> {nonce}
//   POST /payout-account         {agent, nonce, signature}  -> {url}  (Stripe onboarding)
//   GET  /health
//
// Nothing here moves money on anyone's word: a grant follows only a
// payment Stripe signs for, and a payout account is linked only on the
// agent's own signature.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { agentId, agentKey, type IssuerLedger } from "./ledger.ts";
import { newNonce, verifyLink } from "./link.ts";
import type { PaymentRail } from "./rail.ts";
import type { Store } from "./store.ts";
import { grantPayment } from "./topups.ts";

/// Card top-ups, per payment: at least enough to be worth the card fee, at
/// most well under the closed-loop prepaid limit of $2,000 a day.
const MIN_TOPUP_CENTS = 500;
const MAX_TOPUP_CENTS = 50_000;
/// How long a link nonce stays good.
const NONCE_MAX_AGE_MS = 10 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface Deps {
  store: Store;
  ledger: IssuerLedger;
  rail: PaymentRail;
  /// The app's origin, allowed to call this from the browser.
  appOrigin: string;
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

export function handler(deps: Deps) {
  const { store, ledger, rail, appOrigin, log = () => {} } = deps;
  const routes: Record<string, (req: IncomingMessage) => Promise<unknown>> = {
    "GET /health": async () => ({ ok: true }),

    "POST /topups": async (req) => {
      const input = await json(req);
      const agent = agentFrom(input.agent);
      const amount = input.amount;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount < MIN_TOPUP_CENTS || amount > MAX_TOPUP_CENTS) {
        throw new HttpError(400, `Add between ${MIN_TOPUP_CENTS / 100} and ${MAX_TOPUP_CENTS / 100} dollars at a time.`);
      }
      return { url: await rail.topUpUrl(agent, amount) };
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

    "POST /payout-account/nonce": async (req) => {
      const agent = agentFrom((await json(req)).agent);
      const nonce = newNonce();
      store.issueNonce(nonce, agent);
      return { nonce, issuer: agentId(ledger.issuer) };
    },

    "POST /payout-account": async (req) => {
      const input = await json(req);
      const agent = agentFrom(input.agent);
      const { nonce, signature } = input;
      if (typeof nonce !== "string" || typeof signature !== "string") throw new HttpError(400, "Send the nonce and your signature.");
      if (!store.takeNonce(nonce, agent, NONCE_MAX_AGE_MS)) throw new HttpError(401, "That link has expired. Try again.");
      if (!verifyLink(agentKey(agent), ledger.issuer, nonce, Buffer.from(signature, "base64"))) throw new HttpError(401, "That signature isn't yours.");
      const { account, url } = await rail.payoutAccountLink(agent, store.payoutAccount(agent));
      store.setPayoutAccount(agent, account);
      return { url };
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
