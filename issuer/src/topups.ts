// Money in: a completed card payment becomes a grant on the ledger, once.
import type { IssuerLedger } from "./ledger.ts";
import { agentKey } from "./ledger.ts";
import type { CompletedPayment } from "./rail.ts";
import type { Store } from "./store.ts";

/// Grants `payment` to the agent it was for -- once, however many times its
/// processor reports it. The grant's reference is the payment's id, so the
/// ledger shows which payment each grant came from.
export async function grantPayment(store: Store, ledger: IssuerLedger, payment: CompletedPayment): Promise<"granted" | "already granted"> {
  if (!store.claimPayment(payment.payment, payment.agent, payment.amount)) return "already granted";
  try {
    await ledger.issueGrant(agentKey(payment.agent), payment.amount, payment.payment);
    return "granted";
  } catch (err) {
    // Not granted: let the processor's retry try again.
    store.releasePayment(payment.payment);
    throw err;
  }
}

/// How far back reconciliation looks: Stripe retries a webhook for three
/// days; a week covers that with room.
export const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/// Grants every payment completed in the window that hasn't been -- a
/// webhook that never arrived, a saved-card charge whose grant failed.
/// Returns how many it granted.
export async function reconcile(store: Store, ledger: IssuerLedger, payments: CompletedPayment[]): Promise<number> {
  let granted = 0;
  for (const payment of payments) {
    if ((await grantPayment(store, ledger, payment)) === "granted") granted++;
  }
  return granted;
}
