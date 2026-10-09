// The ledger: each agent's own chain of holds, collections, waivers and
// deposits, each carrying the balance it leaves them with -- see the ledger
// zome. Money for an order is set aside as the order goes and collected by
// whoever it's owed to, from their own conductor.
import { callZome } from "../client";
import type { ActionHash, AgentPubKey, HcRecord, HoldView } from "../types";

/// An agent's balance: what their latest ledger entry says, which
/// validation ties to every entry before it.
export async function getBalance(agent: AgentPubKey): Promise<number> {
  return callZome("ledger", "get_balance", agent);
}

export interface LedgerPage {
  /// Newest first.
  entries: HcRecord[];
  next_before: number | null;
}

/// The caller's ledger, newest first; pass the previous page's
/// `next_before` to continue.
export async function listMyLedger(before: number | null = null): Promise<LedgerPage> {
  return callZome("ledger", "list_my_ledger", { before });
}

/// Every hold on an order.
export async function holdsForOrder(order: ActionHash): Promise<HoldView[]> {
  return callZome("ledger", "holds_for_order", order);
}

/// Collects any funds issued to the caller; returns how many grants.
export async function collectGrants(): Promise<number> {
  return callZome("ledger", "collect_grants", null);
}
