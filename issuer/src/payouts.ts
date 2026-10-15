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
  // to their new key instead (recovery.ts). A key that handed its account
  // over did so itself, and is paid as usual.
  if ((await ledger.successionsOf(request.redeemer)).some((s) => s.kind !== "HandOver")) {
    return { Declined: { reason: "This account was recovered on a new device, so this key can't cash out. Its balance goes to the new device." } };
  }
  if (store.frozen(agent)) return { Defer: { until: now + FROZEN_RECHECK_MS, reason: "a card payment on this account is disputed" } };
  const net = payoutAfterFees(fee, request.amount);
  if (net === 0) return { Declined: { reason: "After the fee, there'd be nothing to send. Cash out a larger amount." } };

  // The cash-out's own hash keys each refund and transfer: a retried sweep
  // never pays twice.
  const key = `cash-out-${Buffer.from(request.redemption).toString("hex")}`;
  const customer = store.customer(agent);
  const toCards = customer ? Math.min(net, await rail.refundable(customer, key)) : 0;
  const toBank = net - toCards;

  // Settle where the rest goes before any money moves.
  const account = toBank > 0 ? store.payoutAccount(agent) : null;
  if (toBank > 0) {
    if (!account || !(await rail.canPay(account))) {
      const cardOnly = toCards > 0 ? ` You can cash out up to ${format(toCards)} back to your card now.` : "";
      return { Declined: { reason: `There's nowhere to send this yet: set up your payout account (Wallet → Payout account), then cash out again.${cardOnly}` } };
    }
    const from = bankPayoutFrom(await ledger.standingOf(request.redeemer), policy, now);
    if (from > now) return { Defer: { until: from, reason: "a new account's first bank payouts wait" } };
  }

  const references: string[] = [];
  if (toCards > 0) {
    const refunded = await rail.refund(customer!, toCards, key);
    if (refunded) references.push(refunded.reference);
  }
  if (toBank > 0) references.push(await rail.pay(account!, toBank, key));
  return { Paid: { reference: references.join(",") } };
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
