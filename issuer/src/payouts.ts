// Money out: the sweep of cash-outs this issuer has been asked to pay, from
// where the last one stopped. Each is paid to its owner's payout account,
// less the published fee, and recorded as paid with the transfer's id -- or,
// with no account ready, declined, and its funds go back to them.
import { payoutAfterFees, type Fee } from "./fees.ts";
import { agentId, type CashOutRequest, type IssuerLedger, type PayoutOutcome } from "./ledger.ts";
import type { PaymentRail } from "./rail.ts";
import type { Store } from "./store.ts";

const CURSOR = "cash_out_cursor";

/// What to do with one cash-out.
export async function decide(request: CashOutRequest, store: Store, rail: PaymentRail, fee: Fee, setUpUrl: string): Promise<PayoutOutcome> {
  const account = store.payoutAccount(agentId(request.redeemer));
  if (!account || !(await rail.canPay(account))) {
    return { Declined: { reason: `Set up your payout account first, then cash out again: ${setUpUrl}` } };
  }
  const net = payoutAfterFees(fee, request.amount);
  if (net === 0) return { Declined: { reason: "After the fee, there'd be nothing to send. Cash out a larger amount." } };
  // The cash-out's own hash keys the transfer: a retried sweep never pays twice.
  const reference = await rail.pay(account, net, `cash-out-${Buffer.from(request.redemption).toString("hex")}`);
  return { Paid: { reference } };
}

/// One sweep: every cash-out since the last, decided. Returns how many.
export async function sweep(store: Store, ledger: IssuerLedger, rail: PaymentRail, fee: Fee, setUpUrl: string): Promise<number> {
  let after = store.get(CURSOR) === null ? null : Number(store.get(CURSOR));
  let decided = 0;
  for (;;) {
    const page = await ledger.cashOutRequests(after);
    for (const request of page.requests) {
      if (request.outcome) continue;
      try {
        await ledger.decideCashOut(request.redemption, await decide(request, store, rail, fee, setUpUrl));
      } catch (err) {
        // Decided on an earlier try whose answer never came back: done.
        if (!/already been decided/.test(String(err))) throw err;
      }
      decided++;
    }
    // Only past what's all decided: a failure above leaves the cursor, and
    // the next sweep picks up from there.
    if (page.cursor !== null) store.set(CURSOR, String(page.cursor));
    after = page.cursor;
    if (!page.more) return decided;
  }
}
