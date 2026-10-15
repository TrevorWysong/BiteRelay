// Money out: the sweep of cash-outs this issuer has been asked to pay, from
// where the last one stopped. Each is paid to its owner's payout account,
// less the published fee, and recorded as paid with the transfer's id -- or,
// with no account ready, declined, and its funds go back to them.
import { payoutAfterFees, type Fee } from "./fees.ts";
import { agentId, type CashOutRequest, type IssuerLedger, type PayoutOutcome } from "./ledger.ts";
import type { PaymentRail } from "./rail.ts";
import type { Store } from "./store.ts";

const CURSOR = "cash_out_cursor";

/// What to do with one cash-out: to the owner's payout account if they have
/// one ready (stores and drivers); otherwise back to the cards they paid
/// with (customers' unspent funds); otherwise, nowhere to send it yet.
export async function decide(request: CashOutRequest, store: Store, ledger: IssuerLedger, rail: PaymentRail, fee: Fee, setUpUrl: string): Promise<PayoutOutcome> {
  const agent = agentId(request.redeemer);
  // A recovered account's old key may be in someone else's hands now (a
  // lost phone found): it pays nothing out. Its owner's balance is reissued
  // to their new key instead (recovery.ts). A key that handed its account
  // over did so itself, and is paid as usual.
  if ((await ledger.successionsOf(request.redeemer)).some((s) => s.kind !== "HandOver")) {
    return { Declined: { reason: "This account was recovered on a new device, so this key can't cash out. Its balance goes to the new device." } };
  }
  const net = payoutAfterFees(fee, request.amount);
  if (net === 0) return { Declined: { reason: "After the fee, there'd be nothing to send. Cash out a larger amount." } };
  // The cash-out's own hash keys each transfer or refund: a retried sweep
  // never pays twice.
  const key = `cash-out-${Buffer.from(request.redemption).toString("hex")}`;
  const account = store.payoutAccount(agent);
  if (account && (await rail.canPay(account))) return { Paid: { reference: await rail.pay(account, net, key) } };
  const customer = store.customer(agent);
  const refunded = customer ? await rail.refund(customer, net, key) : null;
  if (refunded) return { Paid: { reference: refunded } };
  return { Declined: { reason: `There's nowhere to send this yet: set up your payout account, then cash out again: ${setUpUrl}` } };
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
        await ledger.decideCashOut(request.redemption, await decide(request, store, ledger, rail, fee, setUpUrl));
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
