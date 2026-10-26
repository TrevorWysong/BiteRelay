// Money out: the sweep of cash-outs this issuer has been asked to pay, from
// where the last one stopped. Each is decided once -- paid, or declined and
// its funds go back -- or set aside to decide again later (a young account's
// first bank payout, an account with a disputed card payment).
//
// Paying out, card money goes back to the cards that paid first: refunded
// to the person's recent card payments, newest first. Only what's left
// beyond them -- what they earned -- goes to their bank. So money added
// with a card (perhaps someone else's) can't come out as a bank transfer.
import { payoutAfterFees, type Fee } from "./fees.ts";
import { agentId, type CashOutRequest, type IssuerLedger, type PayoutOutcome } from "./ledger.ts";
import type { PaymentRail } from "./rail.ts";
import { bankPayoutFrom, type RiskPolicy } from "./risk.ts";
import type { Store } from "./store.ts";
import { refusal } from "./refusal.ts";

const CURSOR = "cash_out_cursor";
/// How soon a frozen account's cash-out is looked at again.
const FROZEN_RECHECK_MS = 24 * 60 * 60 * 1000;

export interface PayoutDeps {
  store: Store;
  ledger: IssuerLedger;
  rail: PaymentRail;
  fee: Fee;
  policy: RiskPolicy;
  format: (cents: number) => string;
}

/// What to do with a cash-out: pay it, decline it, or decide again `until`.
export type Decision = PayoutOutcome | { Defer: { until: number; reason: string } };

export async function decide(request: CashOutRequest, deps: PayoutDeps, now = Date.now()): Promise<Decision> {
  const { store, ledger, rail, fee, policy, format } = deps;
  const agent = agentId(request.redeemer);
  // A recovered account's old key may be in someone else's hands now (a
  // lost phone found): it pays nothing out. Its owner's balance is reissued
  // to their new key instead (recovery.ts).
  if ((await ledger.successionsOf(request.redeemer)).length > 0) {
    return { Declined: { reason: refusal("This account was recovered on a new device, so this key can't cash out. Its balance goes to the new device.") } };
  }
  if (store.frozen(agent)) return { Defer: { until: now + FROZEN_RECHECK_MS, reason: "a card payment on this account is disputed" } };
  const afterFee = payoutAfterFees(fee, request.amount);
  if (afterFee === 0) return { Declined: { reason: refusal("After the fee, there'd be nothing to send. Cash out a larger amount.") } };

  // The cash-out's own hash keys each refund and transfer: a retried sweep
  // never pays twice.
  const redemption = Buffer.from(request.redemption).toString("hex");
  const key = `cash-out-${redemption}`;
  // Arbiters' awards against this account's stores come out first, as a
  // platform takes a refund from a payout (dispatch's appeals).
  const awards = await awardsDue(request, afterFee, deps);
  const net = afterFee - awards.reduce((sum, a) => sum + a.amount, 0);
  const customer = store.customer(agent);
  const toCards = customer ? Math.min(net, await rail.refundable(customer, key)) : 0;
  const toBank = net - toCards;

  // Settle where the rest goes before any money moves.
  const account = toBank > 0 ? store.payoutAccount(agent) : null;
  if (toBank > 0) {
    if (!account || !(await rail.canPay(account))) {
      // Whole sentences, each its own message: the app translates them whole.
      const reason =
        toCards > 0
          ? refusal(`There's nowhere to send this yet: set up your payout account (Wallet → Payout account), then cash out again. You can cash out up to ${format(toCards)} back to your card now.`)
          : refusal("There's nowhere to send this yet: set up your payout account (Wallet → Payout account), then cash out again.");
      return { Declined: { reason } };
    }
    const from = bankPayoutFrom(await ledger.standingOf(request.redeemer), policy, now);
    if (from > now) return { Defer: { until: from, reason: "a new account's first bank payouts wait" } };
  }

  // Paid as credits to each customer, once per award and cash-out.
  for (const award of awards) {
    await ledger.issueGrant(award.customer, award.amount, `award:${award.ruling}:${redemption}`);
    store.recordAwardPayment(award.ruling, redemption, award.amount);
  }
  const references: string[] = awards.length > 0 ? [`awards:${awards.length}`] : [];
  if (toCards > 0) {
    const refunded = await rail.refund(customer!, toCards, key);
    if (refunded) references.push(refunded.reference);
  }
  if (toBank > 0) references.push(await rail.pay(account!, toBank, key));
  return { Paid: { reference: references.join(",") } };
}

/// The awards this cash-out pays, oldest first, as far as `available`
/// reaches -- what's left of an award waits for the next cash-out.
async function awardsDue(request: CashOutRequest, available: number, deps: PayoutDeps): Promise<{ ruling: string; customer: Uint8Array; amount: number }[]> {
  const { store, ledger } = deps;
  const redemption = Buffer.from(request.redemption).toString("hex");
  const due: { ruling: string; customer: Uint8Array; amount: number }[] = [];
  let left = available;
  for (const ruling of await ledger.rulingsAgainst(request.redeemer)) {
    if (left === 0) break;
    const id = Buffer.from(ruling.ruling).toString("hex");
    // A retried sweep pays what this cash-out already paid, again: the
    // grant's reference makes that a no-op.
    const owed = ruling.award - store.awardPaid(id) + (store.awardsFromFor(id, redemption));
    const amount = Math.min(owed, left);
    if (amount <= 0) continue;
    due.push({ ruling: id, customer: ruling.customer, amount });
    left -= amount;
  }
  return due;
}

/// One sweep: every cash-out since the last, decided or set aside, and
/// every set-aside one that's due, decided again. Returns how many were
/// decided.
export async function sweep(deps: PayoutDeps, now = Date.now()): Promise<number> {
  const { store, ledger } = deps;
  let decided = 0;
  const settle = async (request: CashOutRequest) => {
    const redemption = Buffer.from(request.redemption).toString("hex");
    const decision = await decide(request, deps, now);
    if ("Defer" in decision) {
      store.defer(redemption, JSON.stringify(encode(request)), decision.Defer.until, decision.Defer.reason);
      return;
    }
    try {
      await ledger.decideCashOut(request.redemption, decision);
    } catch (err) {
      // Decided on an earlier try whose answer never came back: done.
      if (!/already been decided/.test(String(err))) throw err;
    }
    store.undefer(redemption);
    decided++;
  };

  let after = store.get(CURSOR) === null ? null : Number(store.get(CURSOR));
  for (;;) {
    const page = await ledger.cashOutRequests(after);
    for (const request of page.requests) if (!request.outcome) await settle(request);
    // Only past what's all decided or set aside: a failure above leaves
    // the cursor, and the next sweep picks up from there.
    if (page.cursor !== null) store.set(CURSOR, String(page.cursor));
    after = page.cursor;
    if (!page.more) break;
  }
  for (const raw of store.dueDeferred(now)) await settle(decode(raw));
  return decided;
}

/// A request as the store keeps it: its byte fields in base64.
function encode(request: CashOutRequest) {
  return { ...request, redemption: Buffer.from(request.redemption).toString("base64"), redeemer: Buffer.from(request.redeemer).toString("base64") };
}

function decode(raw: string): CashOutRequest {
  const parsed = JSON.parse(raw) as ReturnType<typeof encode>;
  return { ...parsed, redemption: new Uint8Array(Buffer.from(parsed.redemption, "base64")), redeemer: new Uint8Array(Buffer.from(parsed.redeemer, "base64")) };
}
