// Proves cashing out: a store or driver asks an issuer to pay part of their
// balance out of the network; only money that's there leaves -- never
// credit, even on a network that extends it; only the issuer a cash-out
// names decides it, once; and only a declined one comes back, once.
// Forgeries are written raw (test-utils), as a modified client would.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import { EMPTY_HANDS, latestLedgerEntry, retryUntil, retryUntilOk, setupPlayersWithProperties, useTestCoordinators } from "./helpers.js";
import { verifyLink } from "../../../issuer/src/link.js";

const MIN = 500;

interface CashOutView {
  redemption: Uint8Array;
  amount: number;
  status: "Pending" | { Paid: { reference: string } } | { Declined: { reason: string } } | { Returned: { reason: string } };
}
interface CashOutRequest {
  redemption: Uint8Array;
  redeemer: Uint8Array;
  amount: number;
  requested_at: number;
  instructions: string;
  outcome: unknown;
}

await runScenario(async (scenario) => {
  // A network that extends credit -- which a cash-out must never touch.
  const [issuer, earner, stranger] = await setupPlayersWithProperties(scenario, 3, (keys) => ({ issuers: [keys[0]], credit_limit_cents: 100_000, min_redemption_cents: MIN }));
  const all = [issuer, earner, stranger];
  for (const p of all) await useTestCoordinators(p, ["ledger"]);
  const sync = () => dhtSync(all, earner.cells[0].cell_id[0]);
  const call = (p: typeof earner, zome: string) => getZomeCaller(p.cells[0], zome);
  const ledger = (p: typeof earner) => call(p, "ledger");
  const balance = (p: typeof earner) => ledger(p)<number>("get_balance", p.agentPubKey);
  const forge = async (p: typeof earner, kind: unknown, amount: number, balanceAfter: number) =>
    ledger(p)("create_raw_ledger_entry_for_testing", { kind, amount, balance: balanceAfter, in_hand: EMPTY_HANDS, previous: (await latestLedgerEntry(p)).hash });
  const cashOut = (amount: number, instructions = "") => ledger(earner)<CashOutView>("cash_out", { issuer: issuer.agentPubKey, amount, instructions });
  const requests = (after: number | null = null) => ledger(issuer)<{ requests: CashOutRequest[]; cursor: number | null; more: boolean }>("get_cash_out_requests", { after });

  // Earnings to cash out -- granted once, however often the issuer's service
  // asks (it can't tell whether a call cut off mid-flight went through).
  const grant = await ledger(issuer)<Uint8Array>("issue_grant", { to: earner.agentPubKey, amount: 5000, reference: "earnings-1" });
  const regrant = await ledger(issuer)<Uint8Array>("issue_grant", { to: earner.agentPubKey, amount: 5000, reference: "earnings-1" });
  assert.deepEqual(regrant, grant, "the same payment's grant, not a second one");
  await sync();
  await retryUntilOk(() => ledger(earner)<number>("collect_grants", null).then((n) => (n === 1 ? n : Promise.reject(new Error("not yet")))));
  assert.equal(await balance(earner), 5000);

  // ===== Issuers say who they are =====
  const profile = { name: "Relay Credits", description: "Bank transfer.", contact: "payouts@example.org", payout_fee_cents: 25, payout_fee_basis_points: 25, min_payout_cents: 1000, payout_days: 2 };
  await ledger(issuer)("set_issuer_profile", profile);
  await assert.rejects(ledger(stranger)("set_issuer_profile", { ...profile, name: "Totally Legit" }), /Only an issuer/, "only an issuer has an issuer profile");
  await ledger(issuer)("set_issuer_profile", { ...profile, payout_days: 1 });
  await sync();
  const issuers = await retryUntil(() => ledger(earner)<{ profile: { name: string; payout_days: number } | null }[]>("list_issuers", null), (list) => list[0]?.profile?.payout_days === 1);
  assert.deepEqual(issuers.map((i) => i.profile?.name), ["Relay Credits"], "the roster's issuers, with their latest profile");
  console.log("[PASS] an issuer publishes its terms; nobody else can pose as one");

  // ===== Only money that's there leaves =====
  await assert.rejects(cashOut(MIN - 1), /cash out 1000 or more/, "below the issuer's minimum");
  await assert.rejects(cashOut(5001), /up to your balance/, "nor more than the balance, though the network extends credit");
  await assert.rejects(forge(earner, { Redeem: { issuer: issuer.agentPubKey, instructions: null } }, 6000, -1000), /below zero/, "nor can a modified app cash out credit");
  await assert.rejects(forge(earner, { Redeem: { issuer: stranger.agentPubKey, instructions: null } }, 1000, 4000), /issuer on the network's roster/, "a cash-out goes to an issuer");
  await assert.rejects(forge(earner, { Redeem: { issuer: issuer.agentPubKey, instructions: null } }, MIN - 1, 5000 - MIN + 1), /at least 500/, "of at least the network's minimum");
  console.log("[PASS] only money that's there can be cashed out, to an issuer, above the minimum");

  // ===== Paid =====
  const paid = await cashOut(2000, "acct_123");
  assert.equal(await balance(earner), 3000, "the balance goes down at once");
  await sync();
  const [request] = await retryUntil(() => requests().then((page) => page.requests), (found) => found.length === 1);
  assert.equal(request.amount, 2000);
  assert.equal(request.instructions, "acct_123", "the issuer reads the payout instructions sealed to it");
  assert.equal((await ledger(stranger)<{ requests: CashOutRequest[] }>("get_cash_out_requests", { after: null })).requests.length, 0, "nobody else is asked to pay it");
  await assert.rejects(
    ledger(stranger)("create_raw_redemption_outcome_for_testing", { redemption: paid.redemption, outcome: { Paid: { reference: "po_fake" } } }),
    /only the issuer a cash-out names/,
    "only its issuer decides it",
  );
  await ledger(issuer)("decide_cash_out", { redemption: paid.redemption, outcome: { Paid: { reference: "po_1" } } });
  await assert.rejects(ledger(issuer)("decide_cash_out", { redemption: paid.redemption, outcome: { Declined: { reason: "changed my mind" } } }), /already been decided/);
  await assert.rejects(
    ledger(issuer)("create_raw_redemption_outcome_for_testing", { redemption: paid.redemption, outcome: { Declined: { reason: "changed my mind" } } }),
    /decided once/,
    "a paid cash-out can't also be declined",
  );
  await sync();
  const views = await retryUntil(() => ledger(earner)<CashOutView[]>("list_my_cash_outs", null), (list) => typeof list[0]?.status === "object");
  const status = views[0].status;
  assert.ok(typeof status === "object" && "Paid" in status && status.Paid.reference === "po_1", "the earner sees it paid, with its reference");
  console.log("[PASS] its issuer pays a cash-out, once, and the earner can trace it");

  // ===== Declined, and back =====
  const declined = await cashOut(1000);
  assert.equal(await balance(earner), 2000);
  await sync();
  await retryUntil(() => requests().then((page) => page.requests), (found) => found.length === 2);
  await ledger(issuer)("decide_cash_out", { redemption: declined.redemption, outcome: { Declined: { reason: "Set up your payout account first." } } });
  await sync();
  const outcome = await retryUntil(
    () => ledger(earner)<number>("reclaim_declined_cash_outs", null),
    (n) => n === 1,
  );
  assert.equal(outcome, 1, "a declined cash-out comes back");
  assert.equal(await balance(earner), 3000);
  assert.equal(await ledger(earner)("reclaim_declined_cash_outs", null), 0, "once");
  const [latestView] = await ledger(earner)<CashOutView[]>("list_my_cash_outs", null);
  assert.ok(typeof latestView.status === "object" && "Returned" in latestView.status, "and shows as returned");
  console.log("[PASS] a declined cash-out comes back to its earner, once");

  // ===== What can't come back =====
  const paidOutcome = (await ledger(issuer)<{ requests: CashOutRequest[] }>("get_cash_out_requests", { after: null })).requests.find((r) => Buffer.from(r.redemption).equals(Buffer.from(paid.redemption)));
  assert.ok(paidOutcome?.outcome, "the issuer's sweep shows what it decided");
  await assert.rejects(forge(earner, { Reclaim: { redemption: paid.redemption, outcome: paid.redemption } }, 2000, 5000), /issuer's refusal/, "a paid cash-out never comes back");
  console.log("[PASS] a paid cash-out can't be taken back");

  // ===== The issuer sweeps what's new =====
  const { cursor, more } = await requests();
  assert.equal(more, false);
  const again = await requests(cursor);
  assert.equal(again.requests.length, 0, "a sweep from where it left off finds nothing new");
  assert.deepEqual(again.cursor, cursor, "and keeps its place");
  await cashOut(1000);
  await sync();
  const fresh = await retryUntil(() => requests(cursor).then((p) => p.requests), (found) => found.length === 1);
  assert.equal(fresh[0].amount, 1000, "and finds the next one when it comes");
  console.log("[PASS] an issuer's service sweeps cash-outs in the order they arrive");

  // ===== Linking a payout account =====
  // The zome signs in Rust; the issuer's service verifies in Node -- the same
  // message, byte for byte.
  const nonce = "nonce_0123456789abcdefXYZ";
  const signature = await ledger(earner)<Uint8Array>("sign_issuer_link", { issuer: issuer.agentPubKey, nonce });
  assert.equal(verifyLink(earner.agentPubKey, issuer.agentPubKey, nonce, signature), true, "the issuer's service accepts the earner's signature");
  assert.equal(verifyLink(stranger.agentPubKey, issuer.agentPubKey, nonce, signature), false, "as no one else's");
  await assert.rejects(ledger(earner)("sign_issuer_link", { issuer: stranger.agentPubKey, nonce }), /isn't one of this network's issuers/, "it signs only for an issuer");
  await assert.rejects(ledger(earner)("sign_issuer_link", { issuer: issuer.agentPubKey, nonce: "short" }), /isn't a nonce/, "and only a nonce's shape");
  console.log("[PASS] an earner proves their key to the issuer's service, and nothing else can be signed this way");
});
