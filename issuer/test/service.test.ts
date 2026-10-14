// The service's rules, with Stripe and the ledger faked: money in is granted
// once per payment; money out is paid once per cash-out, less the published
// fee, or declined when there's nowhere to pay it; and a payout account is
// linked only on its agent's own signature.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { payoutAfterFees } from "../src/fees.ts";
import { agentId, type CashOutRequest, type IssuerLedger, type PayoutOutcome } from "../src/ledger.ts";
import { linkMessage, verifyLink } from "../src/link.ts";
import { sweep } from "../src/payouts.ts";
import type { CompletedPayment, PaymentRail } from "../src/rail.ts";
import { serve } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { grantPayment } from "../src/topups.ts";

const FEE = { payoutFeeCents: 55, payoutFeeBasisPoints: 325 };

/// A fresh Ed25519 identity, as an agent key (3-byte prefix, 32-byte key,
/// 4 bytes of location) and a way to sign with it.
function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const key = new Uint8Array([0x84, 0x20, 0x24, ...raw, 0, 0, 0, 0]);
  return { key, sign: (message: Buffer) => new Uint8Array(sign(null, message, privateKey)) };
}

function fakeLedger(requests: CashOutRequest[] = []) {
  const grants: { to: string; amount: number; reference: string }[] = [];
  const decisions: { redemption: string; outcome: PayoutOutcome }[] = [];
  let failNextGrant = false;
  const ledger: IssuerLedger = {
    issuer: identity().key,
    async issueGrant(to, amount, reference) {
      if (failNextGrant) {
        failNextGrant = false;
        throw new Error("conductor unavailable");
      }
      grants.push({ to: agentId(to), amount, reference });
    },
    async cashOutRequests(after) {
      const page = requests.filter((r) => after === null || r.requested_at >= after);
      return { requests: page, cursor: page.length ? Math.max(...page.map((r) => r.requested_at)) + 1 : after, more: false };
    },
    async decideCashOut(redemption, outcome) {
      decisions.push({ redemption: Buffer.from(redemption).toString("hex"), outcome });
      const request = requests.find((r) => Buffer.from(r.redemption).equals(Buffer.from(redemption)));
      if (request) request.outcome = outcome;
    },
    async setProfile() {},
  };
  return { ledger, grants, decisions, failGrant: () => (failNextGrant = true) };
}

function fakeRail(ready: Set<string> = new Set()) {
  const payments: { account: string; amount: number; key: string }[] = [];
  const rail: PaymentRail = {
    topUpUrl: async (agent, amount) => `https://checkout.test/${agent}/${amount}`,
    completedPayment: async (body, signature) => (signature === "good" ? (JSON.parse(body.toString()) as CompletedPayment) : Promise.reject(new Error("forged"))),
    payoutAccountLink: async (agent, existing) => ({ account: existing ?? `acct_${agent.slice(-6)}`, url: "https://connect.test/onboard" }),
    canPay: async (account) => ready.has(account),
    async pay(account, amount, key) {
      // Stripe's idempotency: the same key pays once.
      if (!payments.some((p) => p.key === key)) payments.push({ account, amount, key });
      return `tr_${key.slice(-8)}`;
    },
  };
  return { rail, payments };
}

const request = (n: number, amount: number, redeemer: Uint8Array): CashOutRequest => ({
  redemption: new Uint8Array(39).fill(n),
  redeemer,
  amount,
  requested_at: 1_000 + n,
  instructions: "",
  outcome: null,
});

// The same cases as ledger_types and web/test/wallet.test.ts.
test("a payout is the amount less its fees", () => {
  assert.equal(payoutAfterFees({ payoutFeeCents: 25, payoutFeeBasisPoints: 25 }, 10_000), 10_000 - 25 - 25);
  assert.equal(payoutAfterFees({ payoutFeeCents: 0, payoutFeeBasisPoints: 150 }, 333), 333 - 4);
  assert.equal(payoutAfterFees({ payoutFeeCents: 500, payoutFeeBasisPoints: 0 }, 300), 0);
});

test("a payment is granted once, however often it's reported", async () => {
  const store = new Store(":memory:");
  const { ledger, grants, failGrant } = fakeLedger();
  const payment = { payment: "pi_1", agent: agentId(identity().key), amount: 5000 };
  assert.equal(await grantPayment(store, ledger, payment), "granted");
  assert.equal(await grantPayment(store, ledger, payment), "already granted");
  assert.deepEqual(grants.map((g) => g.reference), ["pi_1"], "its reference is the payment's id");
  // A grant that didn't go through is retried when the payment is reported again.
  failGrant();
  const second = { ...payment, payment: "pi_2" };
  await assert.rejects(grantPayment(store, ledger, second));
  assert.equal(await grantPayment(store, ledger, second), "granted");
});

test("a cash-out is paid to its owner's account, less the fee, once", async () => {
  const store = new Store(":memory:");
  const earner = identity().key;
  store.setPayoutAccount(agentId(earner), "acct_ready");
  const { ledger, decisions } = fakeLedger([request(1, 10_000, earner)]);
  const { rail, payments } = fakeRail(new Set(["acct_ready"]));
  assert.equal(await sweep(store, ledger, rail, FEE, "https://app/#/wallet"), 1);
  assert.deepEqual(payments.map((p) => [p.account, p.amount]), [["acct_ready", payoutAfterFees(FEE, 10_000)]]);
  assert.ok("Paid" in decisions[0].outcome);
  assert.equal(await sweep(store, ledger, rail, FEE, "https://app/#/wallet"), 0, "a decided cash-out isn't decided again");
  assert.equal(payments.length, 1);
});

test("a cash-out whose decision went through on an earlier try counts as decided", async () => {
  const store = new Store(":memory:");
  const earner = identity().key;
  store.setPayoutAccount(agentId(earner), "acct_ready");
  const { ledger } = fakeLedger([request(1, 10_000, earner)]);
  // The decision landed, but its answer was lost: asking again says so.
  ledger.decideCashOut = async () => {
    throw new Error("That cash-out has already been decided.");
  };
  const { rail, payments } = fakeRail(new Set(["acct_ready"]));
  assert.equal(await sweep(store, ledger, rail, FEE, "https://app/#/wallet"), 1, "the sweep carries on");
  // And paying again was a no-op: the transfer is keyed by the cash-out.
  await sweep(store, ledger, rail, FEE, "https://app/#/wallet");
  assert.equal(payments.length, 1);
});

test("with no payout account ready, a cash-out is declined and goes back", async () => {
  const store = new Store(":memory:");
  const unset = identity().key;
  const pending = identity().key;
  store.setPayoutAccount(agentId(pending), "acct_pending");
  const { ledger, decisions } = fakeLedger([request(1, 5000, unset), request(2, 5000, pending)]);
  const { rail, payments } = fakeRail();
  await sweep(store, ledger, rail, FEE, "https://app/#/wallet");
  assert.equal(payments.length, 0);
  assert.equal(decisions.length, 2);
  for (const d of decisions) assert.ok("Declined" in d.outcome && d.outcome.Declined.reason.includes("https://app/#/wallet"), "it says where to set one up");
});

test("a payout account is linked only on its agent's own signature", () => {
  const agent = identity();
  const issuer = identity().key;
  const signature = agent.sign(linkMessage(issuer, "nonce-0123456789abcdef"));
  assert.equal(verifyLink(agent.key, issuer, "nonce-0123456789abcdef", signature), true);
  assert.equal(verifyLink(agent.key, issuer, "nonce-other-0123456789", signature), false, "another nonce");
  assert.equal(verifyLink(agent.key, identity().key, "nonce-0123456789abcdef", signature), false, "another issuer");
  assert.equal(verifyLink(identity().key, issuer, "nonce-0123456789abcdef", signature), false, "someone else's key");
});

test("the HTTP service: top-ups, genuine webhooks, and signed account links", async () => {
  const store = new Store(":memory:");
  const { ledger, grants } = fakeLedger();
  const { rail } = fakeRail();
  const server = serve({ store, ledger, rail, appOrigin: "http://app.test" }, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  try {
    const agent = identity();
    const id = agentId(agent.key);

    assert.equal((await post("/topups", { agent: id, amount: 100 })).status, 400, "too small a top-up");
    assert.equal((await post("/topups", { agent: "nonsense", amount: 5000 })).status, 400, "not an agent");
    assert.equal(((await (await post("/topups", { agent: id, amount: 5000 })).json()) as { url: string }).url, `https://checkout.test/${id}/5000`);

    const payment = JSON.stringify({ payment: "pi_9", agent: id, amount: 5000 });
    assert.equal((await post("/webhooks/stripe", payment, { "stripe-signature": "forged" })).status, 400, "a forged event grants nothing");
    await post("/webhooks/stripe", payment, { "stripe-signature": "good" });
    await post("/webhooks/stripe", payment, { "stripe-signature": "good" });
    assert.equal(grants.length, 1, "a genuine event grants once, however often it's sent");

    const { nonce } = (await (await post("/payout-account/nonce", { agent: id })).json()) as { nonce: string };
    const intruder = identity();
    const forged = Buffer.from(intruder.sign(linkMessage(ledger.issuer, nonce))).toString("base64");
    assert.equal((await post("/payout-account", { agent: id, nonce, signature: forged })).status, 401, "nobody links someone else's payouts");
    const { nonce: fresh } = (await (await post("/payout-account/nonce", { agent: id })).json()) as { nonce: string };
    const signature = Buffer.from(agent.sign(linkMessage(ledger.issuer, fresh))).toString("base64");
    assert.equal((await post("/payout-account", { agent: id, nonce: fresh, signature })).status, 200);
    assert.ok(store.payoutAccount(id));
    assert.equal((await post("/payout-account", { agent: id, nonce: fresh, signature })).status, 401, "a nonce is good once");
  } finally {
    server.close();
  }
});
