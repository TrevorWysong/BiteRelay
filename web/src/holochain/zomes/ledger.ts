import { callZome } from "../client";
import type { AgentPubKey } from "../types";

export async function getBalance(agent: AgentPubKey): Promise<number> {
  return callZome("ledger", "get_balance", agent);
}
