import { callZome } from "../client";
import type { AgentPubKey, HcRecord, Timestamp } from "../types";

export async function getBalance(agent: AgentPubKey): Promise<number> {
  return callZome("ledger", "get_balance", agent);
}

export interface TransactionsPage {
  transactions: HcRecord[];
  next_after: Timestamp | null;
}

/// The "no-skim" transparency dashboard's one real data source -- every
/// LedgerTransaction the connected agent is a party to, full records, not
/// just a summed balance. Paginated; pass the previous page's `next_after`
/// to continue.
export async function listMyTransactions(after: Timestamp | null = null): Promise<TransactionsPage> {
  return callZome("ledger", "list_my_transactions", { after });
}
