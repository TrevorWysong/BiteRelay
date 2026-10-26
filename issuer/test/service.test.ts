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
import { agentId, type CashOutRequest, type IssuerLedger, type MigrationRequest, type PayoutOutcome, type ReissueRequest, type RulingDue, type Standing, type Succession } from "../src/ledger.ts";
import { migrationSweep } from "../src/migrations.ts";
import { linkMessage, verifyLink, type Purpose } from "../src/link.ts";
import { decide, sweep, type PayoutDeps } from "../src/payouts.ts";
import { reissueSweep } from "../src/recovery.ts";
import type { PaymentRail, RailEvent, SavedCardCharge } from "../src/rail.ts";
import { DEFAULT_TIERS, type AccountStanding, type RiskPolicy } from "../src/risk.ts";
import { serve } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { grantPayment, reconcile } from "../src/topups.ts";

const FEE = { payoutFeeCents: 55, payoutFeeBasisPoints: 325 };
const DAY_MS = 24 * 60 * 60 * 1000;
const POLICY: RiskPolicy = { tiers: DEFAULT_TIERS, payoutHoldMs: 7 * DAY_MS };
const format = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/// An account that's been around and ordered: past every limit's first tier.
const SEASONED: AccountStanding = { since: Date.now() - 365 * DAY_MS, completedOrders: 100 };

/// A fresh Ed25519 identity, as an agent key (3-byte prefix, 32-byte key,
/// 4 bytes of location) and a way to sign with it.
function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const key = new Uint8Array([0x84, 0x20, 0x24, ...raw, 0, 0, 0, 0]);
  return { key, sign: (message: Buffer) => new Uint8Array(sign(null, message, privateKey)) };
}

/// What the fake network knows of accounts: who took each over, each
/// account's latest action, and its standing there.
interface Accounts {
  successions: Succession[];
  reissues: ReissueRequest[];
  latest: Map<string, Uint8Array>;
  standing: Map<string, Standing>;
  /// How long each account has existed and done -- seasoned when unset.
  standingOf?: Map<string, AccountStanding>;
  /// This network, and the accounts moving off it.
  network?: Uint8Array;
  migrations?: MigrationRequest[];
  /// Arbiters' awards against each store owner.
  rulings?: RulingDue[];
}

function fakeLedger(requests: CashOutRequest[] = [], accounts: Accounts = { successions: [], reissues: [], latest: new Map(), standing: new Map() }) {
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
      // Idempotent by reference, as `issue_grant` is.
      if (!grants.some((g) => g.reference === reference)) grants.push({ to: agentId(to), amount, reference });
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
    successionsOf: async (account) => accounts.successions.filter((s) => agentId(s.predecessor) === agentId(account)),
    async reissueRequests(after) {
      const page = accounts.reissues.filter((r) => after === null || r.requested_at >= after);
      return { requests: page, cursor: page.length ? Math.max(...page.map((r) => r.requested_at)) + 1 : after, more: false };
    },
    latestActionOf: async (agent) => accounts.latest.get(agentId(agent)) ?? null,
    standingAt: async (agent) => accounts.standing.get(agentId(agent)) ?? { balance: 0 },
    standingOf: async (agent) => accounts.standingOf?.get(agentId(agent)) ?? SEASONED,
    currency: async () => "USD",
    network: async () => accounts.network ?? new Uint8Array(39).fill(7),
    async migrationRequests(after) {
      const page = (accounts.migrations ?? []).filter((r) => after === null || r.requested_at >= after);
      return { requests: page, cursor: page.length ? Math.max(...page.map((r) => r.requested_at)) + 1 : after, more: false };
    },
    rulingsAgainst: async (owner) => (accounts.rulings ?? []).filter((r) => agentId(r.order) === agentId(owner)),
  };
  return { ledger, grants, decisions, failGrant: () => (failNextGrant = true) };
}

/// Stripe, faked: `ready` payout accounts can be paid; `refundable` is what
/// each customer's card payments can still refund; `charge` is what a
/// saved-card charge does.
function fakeRail(options: { ready?: Set<string>; refundable?: Record<string, number>; charge?: "paid" | "confirm" } = {}) {
  const payments: { account: string; amount: number; key: string }[] = [];
  const refunds: { customer: string; amount: number; key: string }[] = [];
  const sessions: { agent: string; customer: string; amount: number; verify: boolean }[] = [];
  const charges: { agent: string; amount: number; key: string }[] = [];
  let customers = 0;
  const rail: PaymentRail = {
    customer: async (_agent, existing) => existing ?? `cus_${++customers}`,
    async embeddedTopUp(agent, customer, amount, { verify }) {
      sessions.push({ agent, customer, amount, verify });
      return `cs_secret_${sessions.length}`;
    },
    event: async (body, signature) => (signature === "good" ? (JSON.parse(body.toString()) as RailEvent) : Promise.reject(new Error("forged"))),
    paymentsSince: async () => [],
    savedCard: async () => ({ brand: "visa", last4: "4242" }),
    async chargeSavedCard(agent, _customer, amount, key): Promise<SavedCardCharge> {
      if (options.charge === "confirm") return { needsConfirmation: true };
      // Stripe's idempotency: the same key charges once.
      if (!charges.some((c) => c.key === key)) charges.push({ agent, amount, key });
      return { paid: { payment: `pi_${key.slice(-6)}`, agent, amount } };
    },
    // What each customer's card payments can take back, less what's been
    // refunded -- counting this cash-out's own refunds, as Stripe's do.
    refundable: async (customer, key) => (options.refundable?.[customer] ?? 0) - refunds.filter((r) => r.customer === customer && r.key !== key).reduce((sum, r) => sum + r.amount, 0),
    async refund(customer, amount, key) {
      const earlier = refunds.find((r) => r.key === key);
      if (earlier) return { reference: `re_${key.slice(-6)}`, amount: earlier.amount };
      const part = Math.min(amount, options.refundable?.[customer] ?? 0);
      if (part <= 0) return null;
      refunds.push({ customer, amount: part, key });
      return { reference: `re_${key.slice(-6)}`, amount: part };
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

const payoutDeps = (store: Store, ledger: IssuerLedger, rail: PaymentRail): PayoutDeps => ({ store, ledger, rail, fee: FEE, policy: POLICY, format });

/// The HTTP service on a free port, with a way to call it.
function running(store: Store, ledger: IssuerLedger, rail: PaymentRail, topUpsPerIpPerHour = 100, noncesPerIpPerHour = 1000) {
  const server = serve({ store, ledger, rail, appOrigins: ["http://app.test"], publishableKey: "pk_test_x", policy: POLICY, topUpsPerIpPerHour, noncesPerIpPerHour, trustProxy: false, format }, 0);
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

test("asking for nonces is limited, and never grows the table", async () => {
  const store = new Store(":memory:");
  const { ledger } = fakeLedger([], noAccounts());
  const { rail } = fakeRail({});
  const service = running(store, ledger, rail, 100, 8);
  try {
    const agent = agentId(identity().key);
    const asks = [];
    for (let i = 0; i < 9; i++) asks.push((await service.post("/nonce", { agent })).status);
    assert.deepEqual(asks, [...new Array(8).fill(200), 429], "an address asks so often an hour, then waits");
  } finally {
    service.close();
  }
  const agent = agentId(identity().key);
  for (let i = 0; i < 20; i++) store.issueNonce(`n${i}`, agent, 60_000);
  assert.equal(store.takeNonce("n0", agent, 60_000), false, "only the newest few are kept");
  assert.equal(store.takeNonce("n19", agent, 60_000), true);
  store.issueNonce("old", agent, 60_000);
  assert.equal(store.takeNonce("old", agent, -1), false, "and an expired one never counts");
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
  assert.equal(await sweep(payoutDeps(store, ledger, rail)), 1);
  assert.deepEqual(payments.map((p) => [p.account, p.amount]), [["acct_ready", payoutAfterFees(FEE, 10_000)]]);
  assert.ok("Paid" in decisions[0].outcome);
  assert.equal(await sweep(payoutDeps(store, ledger, rail)), 0, "a decided cash-out isn't decided again");
  assert.equal(payments.length, 1);
});

test("a customer's unspent funds go back to their card, less the fee", async () => {
  const store = new Store(":memory:");
  const customer = identity().key;
  store.setCustomer(agentId(customer), "cus_paid");
  const { ledger, decisions } = fakeLedger([request(1, 3000, customer)]);
  const { rail, refunds, payments } = fakeRail({ refundable: { cus_paid: 5000 } });
  await sweep(payoutDeps(store, ledger, rail));
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
  await sweep(payoutDeps(store, ledger, rail));
  assert.equal(payments.length + refunds.length, 0);
  assert.equal(decisions.length, 3);
  for (const d of decisions) assert.ok("Declined" in d.outcome && d.outcome.Declined.reason.includes("Wallet → Payout account"), "it says where to set one up");
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
  assert.equal(await sweep(payoutDeps(store, ledger, rail)), 1, "the sweep carries on");
  await sweep(payoutDeps(store, ledger, rail));
  assert.equal(payments.length, 1, "and paying again was a no-op: the transfer is keyed by the cash-out");
});

/// A recovered account on the fake network: `lost`'s old key, recovered
/// onto `found` by `kind`, with `balance` on its ledger.
function recovered(accounts: Accounts, kind: Succession["kind"], balance: number, n: number) {
  const lost = identity().key;
  const found = identity().key;
  const succession = new Uint8Array(39).fill(100 + n);
  accounts.successions.push({ succession, predecessor: lost, successor: found, kind, plan: new Uint8Array(39).fill(200 + n), at: n });
  accounts.reissues.push({ succession, predecessor: lost, successor: found, requested_at: 1_000 + n });
  accounts.latest.set(agentId(lost), new Uint8Array(39).fill(n));
  accounts.standing.set(agentId(lost), { balance });
  return { lost, found, succession };
}

const noAccounts = (): Accounts => ({ successions: [], reissues: [], latest: new Map(), standing: new Map() });

test("a recovered account's balance is reissued to its new key, once, after the old key is quiet", async () => {
  const store = new Store(":memory:");
  const accounts = noAccounts();
  const { lost, found } = recovered(accounts, "Phrase", 4200, 1);
  const { ledger, grants } = fakeLedger([], accounts);
  assert.equal(await reissueSweep(store, ledger, 60_000, 100_000), 0, "the first look starts the wait");
  assert.equal(await reissueSweep(store, ledger, 60_000, 100_000), 0, "and nothing moves before it's over");
  assert.equal(grants.length, 0);
  assert.equal(await reissueSweep(store, ledger, 0, 100_000), 1, "then, quiet throughout, it's reissued");
  assert.deepEqual(grants, [{ to: agentId(found), amount: 4200, reference: `recovery:${agentId(lost)}` }], "what the old key held, to the new one, keyed by the account");
  assert.equal(await reissueSweep(store, ledger, 0, 100_000), 0, "once");
});

test("the old key doing anything starts the wait again", async () => {
  const store = new Store(":memory:");
  const accounts = noAccounts();
  const { lost } = recovered(accounts, "Guardians", 1000, 2);
  const { ledger, grants } = fakeLedger([], accounts);
  await reissueSweep(store, ledger, 0, 100_000);
  accounts.latest.set(agentId(lost), new Uint8Array(39).fill(99));
  assert.equal(await reissueSweep(store, ledger, 0, 100_000), 0, "someone used the old key: wait again");
  assert.equal(await reissueSweep(store, ledger, 0, 100_000), 1);
  assert.equal(grants.length, 1);
});

test("an account recovered onto two keys is left for review", async () => {
  const store = new Store(":memory:");
  const accounts = noAccounts();
  const { lost } = recovered(accounts, "Phrase", 5000, 3);
  const second = identity().key;
  const succession = new Uint8Array(39).fill(120);
  accounts.successions.push({ succession, predecessor: lost, successor: second, kind: "Guardians", plan: new Uint8Array(39).fill(204), at: 4 });
  accounts.reissues.push({ succession, predecessor: lost, successor: second, requested_at: 1_010 });
  const { ledger, grants } = fakeLedger([], accounts);
  for (let i = 0; i < 3; i++) await reissueSweep(store, ledger, 0, 100_000);
  assert.equal(grants.length, 0, "nobody is paid twice");
});

test("a recovery whose plan the person replaced reissues nothing", async () => {
  const store = new Store(":memory:");
  const accounts = noAccounts();
  recovered(accounts, "Phrase", 3000, 8);
  // The network no longer counts it: the account's plan has changed.
  accounts.successions.length = 0;
  const { ledger, grants } = fakeLedger([], accounts);
  for (let i = 0; i < 3; i++) await reissueSweep(store, ledger, 0, 100_000);
  assert.equal(grants.length, 0);
});

test("a recovered account's old key can't cash out; an account in use can", async () => {
  const store = new Store(":memory:");
  const accounts = noAccounts();
  const { lost } = recovered(accounts, "Phrase", 0, 6);
  const movedOn = identity().key;
  store.setPayoutAccount(agentId(lost), "acct_lost");
  store.setPayoutAccount(agentId(movedOn), "acct_moved");
  const { ledger, decisions } = fakeLedger([request(1, 5000, lost), request(2, 5000, movedOn)], accounts);
  const { rail, payments } = fakeRail({ ready: new Set(["acct_lost", "acct_moved"]) });
  await sweep(payoutDeps(store, ledger, rail));
  assert.ok("Declined" in decisions[0].outcome && decisions[0].outcome.Declined.reason.includes("recovered"), "a found phone pays nothing out");
  assert.ok("Paid" in decisions[1].outcome, "an account still on its key is paid as usual");
  assert.deepEqual(payments.map((p) => p.account), ["acct_moved"]);
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
    const payment = JSON.stringify({ kind: "paid", payment: { payment: "pi_9", agent: id, amount: 5000 } });
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

/// A fake network where `who` is a brand-new account with no orders.
function newcomer(who: Uint8Array): Accounts {
  return { successions: [], reissues: [], latest: new Map(), standing: new Map(), standingOf: new Map([[agentId(who), { since: Date.now(), completedOrders: 0 }]]) };
}

test("a new account adds a little at first, counting card forms opened, and more as it orders", async () => {
  const store = new Store(":memory:");
  const me = identity();
  const accounts = newcomer(me.key);
  const { ledger } = fakeLedger([], accounts);
  const { rail, sessions } = fakeRail();
  const service = running(store, ledger, rail);
  try {
    const topUp = async (amount: number) => service.post("/topups", await service.signed(me, "TopUp", { amount }));
    assert.equal((await topUp(6000)).status, 200);
    assert.equal((await topUp(4000)).status, 200, "up to the first tier's daily limit");
    const refused = await topUp(500);
    assert.equal(refused.status, 429, "forms opened count, paid or not");
    assert.match(((await refused.json()) as { error: string }).error, /add \$0\.00 more.*grows as you order/);
    assert.equal(sessions.length, 2);
    accounts.standingOf!.set(agentId(me.key), { since: Date.now() - 40 * DAY_MS, completedOrders: 25 });
    assert.equal((await topUp(50_000)).status, 200, "an account that's ordered for a month may add far more");
  } finally {
    service.close();
  }
});

test("a card's first payment is verified with its bank; later ones aren't asked again", async () => {
  const store = new Store(":memory:");
  const me = identity();
  const { ledger } = fakeLedger();
  const { rail, sessions } = fakeRail();
  const service = running(store, ledger, rail);
  try {
    await service.post("/topups", await service.signed(me, "TopUp", { amount: 2000 }));
    await grantPayment(store, ledger, { payment: "pi_first", agent: agentId(me.key), amount: 2000 });
    await service.post("/topups", await service.signed(me, "TopUp", { amount: 2000 }));
    assert.deepEqual(sessions.map((s) => s.verify), [true, false]);
  } finally {
    service.close();
  }
});

test("one address opening card form after card form is stopped", async () => {
  const store = new Store(":memory:");
  const { ledger } = fakeLedger();
  const { rail } = fakeRail();
  const service = running(store, ledger, rail, 2);
  try {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await service.post("/topups", await service.signed(identity(), "TopUp", { amount: 1000 }))).status);
    assert.deepEqual(statuses, [200, 200, 429], "many accounts, one address: someone testing cards");
  } finally {
    service.close();
  }
});

test("a disputed payment freezes its account -- nothing in, cash-outs held -- until the dispute is won", async () => {
  const store = new Store(":memory:");
  const me = identity();
  const id = agentId(me.key);
  store.setPayoutAccount(id, "acct_ready");
  const { ledger, decisions } = fakeLedger([request(1, 5000, me.key)]);
  const { rail, payments } = fakeRail({ ready: new Set(["acct_ready"]) });
  const service = running(store, ledger, rail);
  const event = (body: unknown) => service.post("/webhooks/stripe", JSON.stringify(body), { "stripe-signature": "good" });
  try {
    await event({ kind: "paid", payment: { payment: "pi_d", agent: id, amount: 5000 } });
    await event({ kind: "disputed", payment: "pi_d", amount: 5000 });
    const refused = await service.post("/topups", await service.signed(me, "TopUp", { amount: 1000 }));
    assert.equal(refused.status, 429);
    assert.match(((await refused.json()) as { error: string }).error, /disputed/);
    assert.equal(await sweep(payoutDeps(store, ledger, rail)), 0, "the cash-out is held, not paid nor declined");
    assert.equal(decisions.length, 0);

    await event({ kind: "dispute closed", payment: "pi_d", won: true });
    assert.equal(await sweep(payoutDeps(store, ledger, rail), Date.now() + 2 * DAY_MS), 1, "won: the held cash-out is paid when it's looked at again");
    assert.equal(payments.length, 1);
  } finally {
    service.close();
  }
});

test("a lost dispute keeps the account frozen", async () => {
  const store = new Store(":memory:");
  const id = agentId(identity().key);
  store.claimPayment("pi_l", id, 3000);
  store.openDispute("pi_l", id, 3000);
  store.closeDispute("pi_l", false);
  assert.equal(store.frozen(id), true);
});

test("a cash-out goes back to the cards that paid first, and only what's left to the bank", async () => {
  const store = new Store(":memory:");
  const earner = identity().key;
  store.setCustomer(agentId(earner), "cus_paid");
  store.setPayoutAccount(agentId(earner), "acct_ready");
  const { ledger, decisions } = fakeLedger([request(1, 10_000, earner)]);
  const { rail, refunds, payments } = fakeRail({ refundable: { cus_paid: 2000 }, ready: new Set(["acct_ready"]) });
  await sweep(payoutDeps(store, ledger, rail));
  const net = payoutAfterFees(FEE, 10_000);
  assert.deepEqual(refunds.map((r) => r.amount), [2000], "card money back to the card");
  assert.deepEqual(payments.map((p) => p.amount), [net - 2000], "earnings to the bank");
  assert.ok("Paid" in decisions[0].outcome && /re_.*,tr_/.test(decisions[0].outcome.Paid.reference));
});

test("a new account's bank payout waits until it's old enough; its refunds to card don't", async () => {
  const store = new Store(":memory:");
  const earner = identity().key;
  const refunder = identity().key;
  store.setPayoutAccount(agentId(earner), "acct_ready");
  store.setCustomer(agentId(refunder), "cus_paid");
  const accounts = newcomer(earner);
  accounts.standingOf!.set(agentId(refunder), { since: Date.now(), completedOrders: 0 });
  const { ledger, decisions } = fakeLedger([request(1, 5000, earner), request(2, 3000, refunder)], accounts);
  const { rail, payments, refunds } = fakeRail({ ready: new Set(["acct_ready"]), refundable: { cus_paid: 5000 } });
  assert.equal(await sweep(payoutDeps(store, ledger, rail)), 1, "the refund goes now");
  assert.equal(refunds.length, 1);
  assert.equal(payments.length, 0, "the bank payout waits");
  assert.equal(await sweep(payoutDeps(store, ledger, rail), Date.now() + 3 * DAY_MS), 0, "still too new");
  assert.equal(await sweep(payoutDeps(store, ledger, rail), Date.now() + 8 * DAY_MS), 1, "a week on, it's paid");
  assert.equal(payments.length, 1);
  assert.equal(decisions.length, 2);
});

test("a large recovered balance is left for a person to approve", async () => {
  const store = new Store(":memory:");
  const accounts = noAccounts();
  recovered(accounts, "Phrase", 80_000, 9);
  const { ledger, grants } = fakeLedger([], accounts);
  for (let i = 0; i < 3; i++) await reissueSweep(store, ledger, 0, 50_000);
  assert.equal(grants.length, 0);
});

test("a balance moving to the next network is credited there once, only after the old chain closes", async () => {
  const store = new Store(":memory:");
  const next = new Uint8Array(39).fill(9);
  const elsewhere = new Uint8Array(39).fill(8);
  const [mover, other] = [identity().key, identity().key];
  const [moverNew, otherNew] = [identity().key, identity().key];
  const request: MigrationRequest = { migration: new Uint8Array(39).fill(1), account: mover, successor: moverNew, network: next, requested_at: 1_001, close: null };
  const previousAccounts = noAccounts();
  previousAccounts.migrations = [request, { migration: new Uint8Array(39).fill(2), account: other, successor: otherNew, network: elsewhere, requested_at: 1_002, close: new Uint8Array(39).fill(3) }];
  previousAccounts.standing.set(agentId(mover), { balance: 4500 });
  previousAccounts.standing.set(agentId(other), { balance: 999 });
  const { ledger: previous } = fakeLedger([], previousAccounts);
  const currentAccounts = noAccounts();
  currentAccounts.network = next;
  const { ledger: current, grants } = fakeLedger([], currentAccounts);

  assert.equal(await migrationSweep(store, previous, current), 0, "not before the old chain closes");
  request.close = new Uint8Array(39).fill(4);
  assert.equal(await migrationSweep(store, previous, current), 1);
  assert.deepEqual(grants, [{ to: agentId(moverNew), amount: 4500, reference: `migration:${agentId(mover)}` }], "what the closed ledger held, to the new key; a move to another network isn't this issuer's");
  assert.equal(await migrationSweep(store, previous, current), 0, "once");
});

test("an arbiter's award comes out of the store's cash-outs, oldest first, until it's paid -- once", async () => {
  const store = new Store(":memory:");
  const owner = identity().key;
  const [alice, bob] = [identity().key, identity().key];
  store.setPayoutAccount(agentId(owner), "acct_ready");
  // `order` stands in for the store owner in the fake ledger's lookup.
  const ruling = (n: number, customer: Uint8Array, award: number): RulingDue => ({ ruling: new Uint8Array(39).fill(n), appeal: new Uint8Array(39).fill(n + 50), order: owner, customer, award, ruled_at: n });
  const accounts = { successions: [], reissues: [], latest: new Map(), standing: new Map(), rulings: [ruling(1, alice, 3_000), ruling(2, bob, 4_000)] };
  const first = payoutAfterFees(FEE, 5_000);
  const { ledger, grants, decisions } = fakeLedger([request(1, 5_000, owner), request(2, 10_000, owner)], accounts);
  const { rail, payments } = fakeRail({ ready: new Set(["acct_ready"]) });

  // The first cash-out pays Alice's award in full and what's left to Bob's.
  const deps = payoutDeps(store, ledger, rail);
  assert.equal(await decide(request(1, 5_000, owner), deps).then((d) => "Paid" in d), true);
  assert.deepEqual(grants.map((g) => [g.to, g.amount]), [[agentId(alice), 3_000], [agentId(bob), first - 3_000]]);
  assert.equal(payments.length, 0, "nothing left for the store from it");
  // Decided again (a retried sweep): nothing more is granted.
  await decide(request(1, 5_000, owner), deps);
  assert.equal(grants.length, 2);

  // The next pays the rest of Bob's, and the store the remainder.
  await decide(request(2, 10_000, owner), deps);
  const second = payoutAfterFees(FEE, 10_000);
  const rest = 4_000 - (first - 3_000);
  assert.deepEqual(grants.slice(2).map((g) => [g.to, g.amount]), [[agentId(bob), rest]]);
  assert.deepEqual(payments.map((p) => p.amount), [second - rest]);
  assert.equal(store.awardPaid(Buffer.from(ruling(2, bob, 0).ruling).toString("hex")), 4_000, "paid in full, across two cash-outs");
  void decisions;
});
