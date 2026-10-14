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
