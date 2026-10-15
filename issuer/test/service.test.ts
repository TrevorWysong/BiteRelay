// The service's rules, with Stripe and the ledger faked: money in is granted
// once per payment, however it arrives; money out is paid once per
// cash-out, less the published fee -- to a payout account, or back to the
// cards paid with -- or declined when there's nowhere to send it; and only
// an agent's own signature, for that purpose, saves a card to them, pays
// with it, or links their payouts.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { payoutAfterFees } from "../src/fees.ts";
import { agentId, type CashOutRequest, type IssuerLedger, type PayoutOutcome } from "../src/ledger.ts";
import { linkMessage, verifyLink, type Purpose } from "../src/link.ts";
import { sweep } from "../src/payouts.ts";
import type { CompletedPayment, PaymentRail, SavedCardCharge } from "../src/rail.ts";
import { serve } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { grantPayment, reconcile } from "../src/topups.ts";

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

/// Stripe, faked: `ready` payout accounts can be paid; `refundable` is what
/// each customer's card payments can still refund; `charge` is what a
/// saved-card charge does.
function fakeRail(options: { ready?: Set<string>; refundable?: Record<string, number>; charge?: "paid" | "confirm" } = {}) {
  const payments: { account: string; amount: number; key: string }[] = [];
  const refunds: { customer: string; amount: number; key: string }[] = [];
  const sessions: { agent: string; customer: string; amount: number }[] = [];
  const charges: { agent: string; amount: number; key: string }[] = [];
  let customers = 0;
  const rail: PaymentRail = {
    customer: async (_agent, existing) => existing ?? `cus_${++customers}`,
    async embeddedTopUp(agent, customer, amount) {
      sessions.push({ agent, customer, amount });
      return `cs_secret_${sessions.length}`;
    },
    completedPayment: async (body, signature) => (signature === "good" ? (JSON.parse(body.toString()) as CompletedPayment) : Promise.reject(new Error("forged"))),
    paymentsSince: async () => [],
    savedCard: async () => ({ brand: "visa", last4: "4242" }),
    async chargeSavedCard(agent, _customer, amount, key): Promise<SavedCardCharge> {
      if (options.charge === "confirm") return { needsConfirmation: true };
      // Stripe's idempotency: the same key charges once.
      if (!charges.some((c) => c.key === key)) charges.push({ agent, amount, key });
      return { paid: { payment: `pi_${key.slice(-6)}`, agent, amount } };
    },
    async refund(customer, amount, key) {
      if ((options.refundable?.[customer] ?? 0) < amount) return null;
      if (!refunds.some((r) => r.key === key)) refunds.push({ customer, amount, key });
      return `re_${key.slice(-6)}`;
    },
    payoutAccountLink: async (agent, existing) => ({ account: existing ?? `acct_${agent.slice(-6)}`, url: "https://connect.test/onboard" }),
    canPay: async (account) => options.ready?.has(account) ?? false,
    async pay(account, amount, key) {
      if (!payments.some((p) => p.key === key)) payments.push({ account, amount, key });
      return `tr_${key.slice(-8)}`;
    },
  };
  return { rail, payments, refunds, sessions, charges };
}

const request = (n: number, amount: number, redeemer: Uint8Array): CashOutRequest => ({
  redemption: new Uint8Array(39).fill(n),
  redeemer,
  amount,
  requested_at: 1_000 + n,
  instructions: "",
  outcome: null,
});

/// The HTTP service on a free port, with a way to call it.
function running(store: Store, ledger: IssuerLedger, rail: PaymentRail) {
  const server = serve({ store, ledger, rail, appOrigin: "http://app.test", publishableKey: "pk_test_x" }, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  /// A request signed by `who` for `purpose`, on a fresh nonce.
  const signed = async (who: ReturnType<typeof identity>, purpose: Purpose, extra: Record<string, unknown> = {}) => {
    const id = agentId(who.key);
    const { nonce } = (await (await post("/nonce", { agent: id })).json()) as { nonce: string };
    return { agent: id, nonce, signature: Buffer.from(who.sign(linkMessage(purpose, ledger.issuer, nonce))).toString("base64"), ...extra };
  };
  return { post, signed, close: () => server.close() };
}

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

test("reconciliation grants exactly the payments that have no grant, once", async () => {
  const store = new Store(":memory:");
  const { ledger, grants } = fakeLedger();
  const agent = agentId(identity().key);
  await grantPayment(store, ledger, { payment: "pi_seen", agent, amount: 2000 });
  const recent = [
    { payment: "pi_seen", agent, amount: 2000 },
    { payment: "pi_missed", agent, amount: 3000 },
  ];
  assert.equal(await reconcile(store, ledger, recent), 1, "the webhook that never arrived");
  assert.equal(await reconcile(store, ledger, recent), 0, "and never twice");
  assert.deepEqual(grants.map((g) => g.reference), ["pi_seen", "pi_missed"]);
});

test("a cash-out goes to a ready payout account, less the fee, once", async () => {
  const store = new Store(":memory:");
  const earner = identity().key;
  store.setPayoutAccount(agentId(earner), "acct_ready");
  const { ledger, decisions } = fakeLedger([request(1, 10_000, earner)]);
  const { rail, payments } = fakeRail({ ready: new Set(["acct_ready"]) });
  assert.equal(await sweep(store, ledger, rail, FEE, "https://app/#/wallet"), 1);
  assert.deepEqual(payments.map((p) => [p.account, p.amount]), [["acct_ready", payoutAfterFees(FEE, 10_000)]]);
  assert.ok("Paid" in decisions[0].outcome);
  assert.equal(await sweep(store, ledger, rail, FEE, "https://app/#/wallet"), 0, "a decided cash-out isn't decided again");
  assert.equal(payments.length, 1);
});

test("a customer's unspent funds go back to their card, less the fee", async () => {
  const store = new Store(":memory:");
  const customer = identity().key;
  store.setCustomer(agentId(customer), "cus_paid");
  const { ledger, decisions } = fakeLedger([request(1, 3000, customer)]);
  const { rail, refunds, payments } = fakeRail({ refundable: { cus_paid: 5000 } });
  await sweep(store, ledger, rail, FEE, "https://app/#/wallet");
  assert.deepEqual(refunds.map((r) => [r.customer, r.amount]), [["cus_paid", payoutAfterFees(FEE, 3000)]]);
  assert.equal(payments.length, 0);
  assert.ok("Paid" in decisions[0].outcome && decisions[0].outcome.Paid.reference.startsWith("re_"));
});

test("with nowhere to send it, a cash-out is declined and goes back", async () => {
  const store = new Store(":memory:");
  const unset = identity().key;
  const pending = identity().key;
  const overdrawn = identity().key;
  store.setPayoutAccount(agentId(pending), "acct_pending");
  // Paid by card, but less than this cash-out asks for.
  store.setCustomer(agentId(overdrawn), "cus_small");
  const { ledger, decisions } = fakeLedger([request(1, 5000, unset), request(2, 5000, pending), request(3, 5000, overdrawn)]);
  const { rail, payments, refunds } = fakeRail({ refundable: { cus_small: 1000 } });
  await sweep(store, ledger, rail, FEE, "https://app/#/wallet");
  assert.equal(payments.length + refunds.length, 0);
  assert.equal(decisions.length, 3);
  for (const d of decisions) assert.ok("Declined" in d.outcome && d.outcome.Declined.reason.includes("https://app/#/wallet"), "it says where to set one up");
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
  const { rail, payments } = fakeRail({ ready: new Set(["acct_ready"]) });
  assert.equal(await sweep(store, ledger, rail, FEE, "https://app/#/wallet"), 1, "the sweep carries on");
  await sweep(store, ledger, rail, FEE, "https://app/#/wallet");
  assert.equal(payments.length, 1, "and paying again was a no-op: the transfer is keyed by the cash-out");
});

test("a signature counts only for its agent, its issuer, its nonce and its purpose", () => {
  const agent = identity();
  const issuer = identity().key;
  const signature = agent.sign(linkMessage("PayoutAccount", issuer, "nonce-0123456789abcdef"));
  assert.equal(verifyLink(agent.key, "PayoutAccount", issuer, "nonce-0123456789abcdef", signature), true);
  assert.equal(verifyLink(agent.key, "TopUp", issuer, "nonce-0123456789abcdef", signature), false, "another purpose");
  assert.equal(verifyLink(agent.key, "PayoutAccount", issuer, "nonce-other-0123456789", signature), false, "another nonce");
  assert.equal(verifyLink(agent.key, "PayoutAccount", identity().key, "nonce-0123456789abcdef", signature), false, "another issuer");
  assert.equal(verifyLink(identity().key, "PayoutAccount", issuer, "nonce-0123456789abcdef", signature), false, "someone else's key");
});

test("adding funds: only the agent themselves opens a card form for their account", async () => {
  const store = new Store(":memory:");
  const { ledger } = fakeLedger();
  const { rail, sessions } = fakeRail();
  const service = running(store, ledger, rail);
  try {
    const me = identity();
    const intruder = identity();
    const forged = await service.signed(intruder, "TopUp", { amount: 5000 });
    assert.equal((await service.post("/topups", { ...forged, agent: agentId(me.key) })).status, 401, "someone else can't open one for me");
    const wrongPurpose = await service.signed(me, "PayoutAccount", { amount: 5000 });
    assert.equal((await service.post("/topups", wrongPurpose)).status, 401, "a signature for another purpose doesn't count");
    assert.equal((await service.post("/topups", await service.signed(me, "TopUp", { amount: 100 }))).status, 400, "too small a payment");
    const ok = await service.post("/topups", await service.signed(me, "TopUp", { amount: 5000 }));
    assert.equal(((await ok.json()) as { clientSecret: string }).clientSecret, "cs_secret_1");
    assert.deepEqual(sessions.map((s) => [s.agent, s.amount]), [[agentId(me.key), 5000]]);
    assert.equal(store.customer(agentId(me.key)), sessions[0].customer, "their card is kept with their own customer record");
  } finally {
    service.close();
  }
});

test("a saved card: charged only on its agent's signature, granted at once, once, within a daily limit", async () => {
  const store = new Store(":memory:");
  const { ledger, grants } = fakeLedger();
  const { rail, charges } = fakeRail();
  const service = running(store, ledger, rail);
  try {
    const me = identity();
    assert.equal((await service.post("/saved-card/charge", await service.signed(me, "SavedCard", { amount: 2000 }))).status, 409, "no card saved yet");
    store.setCustomer(agentId(me.key), "cus_1");
    const card = (await (await service.post("/saved-card", await service.signed(me, "SavedCard"))).json()) as { card: { last4: string } };
    assert.equal(card.card.last4, "4242");
    const forged = await service.signed(identity(), "SavedCard", { amount: 2000 });
    assert.equal((await service.post("/saved-card/charge", { ...forged, agent: agentId(me.key) })).status, 401, "nobody charges my card but me");
    assert.equal((await service.post("/saved-card/charge", await service.signed(me, "SavedCard", { amount: 2000 }))).status, 200);
    assert.deepEqual(grants.map((g) => [g.to, g.amount]), [[agentId(me.key), 2000]], "granted straight away");
    assert.equal(charges.length, 1);
    for (let i = 1; i < 6; i++) await service.post("/saved-card/charge", await service.signed(me, "SavedCard", { amount: 500 }));
    assert.equal((await service.post("/saved-card/charge", await service.signed(me, "SavedCard", { amount: 500 }))).status, 429, "no more than six a day");
  } finally {
    service.close();
  }
});

test("a saved card the bank wants confirmed is left to the card form", async () => {
  const store = new Store(":memory:");
  const { ledger, grants } = fakeLedger();
  const { rail } = fakeRail({ charge: "confirm" });
  const service = running(store, ledger, rail);
  try {
    const me = identity();
    store.setCustomer(agentId(me.key), "cus_1");
    const res = (await (await service.post("/saved-card/charge", await service.signed(me, "SavedCard", { amount: 2000 }))).json()) as { needsConfirmation?: boolean };
    assert.equal(res.needsConfirmation, true);
    assert.equal(grants.length, 0, "and nothing is granted");
  } finally {
    service.close();
  }
});

test("webhooks grant only genuine payments, once; payout accounts link only on their agent's signature", async () => {
  const store = new Store(":memory:");
  const { ledger, grants } = fakeLedger();
  const { rail } = fakeRail();
  const service = running(store, ledger, rail);
  try {
    const me = identity();
    const id = agentId(me.key);
    const payment = JSON.stringify({ payment: "pi_9", agent: id, amount: 5000 });
    assert.equal((await service.post("/webhooks/stripe", payment, { "stripe-signature": "forged" })).status, 400, "a forged event grants nothing");
    await service.post("/webhooks/stripe", payment, { "stripe-signature": "good" });
    await service.post("/webhooks/stripe", payment, { "stripe-signature": "good" });
    assert.equal(grants.length, 1, "a genuine event grants once, however often it's sent");

    const forged = await service.signed(identity(), "PayoutAccount");
    assert.equal((await service.post("/payout-account", { ...forged, agent: id })).status, 401, "nobody links someone else's payouts");
    const mine = await service.signed(me, "PayoutAccount");
    assert.equal((await service.post("/payout-account", mine)).status, 200);
    assert.ok(store.payoutAccount(id));
    assert.equal((await service.post("/payout-account", mine)).status, 401, "a nonce is good once");
  } finally {
    service.close();
  }
});
