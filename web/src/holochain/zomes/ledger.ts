// The ledger: each agent's own chain of holds, collections, waivers and
// deposits, each carrying the balance it leaves them with -- see the ledger
// zome. Money for an order is set aside as the order goes and collected by
// whoever it's owed to, from their own conductor.
import { callZome } from "../client";
import type { ActionHash, AgentPubKey, CashOutView, HcRecord, IssuerRequest, IssuerView } from "../types";

/// An agent's balance: what their latest ledger entry says, which
/// validation ties to every entry before it.
export async function getBalance(agent: AgentPubKey): Promise<number> {
  return callZome("ledger", "get_balance", agent);
}

export interface LedgerPage {
  /// Newest first.
  entries: HcRecord[];
  /// The last entry shown: where the next page starts.
  next_before: ActionHash | null;
}

/// The caller's ledger, newest first; pass the previous page's
/// `next_before` to continue.
export async function listMyLedger(before: ActionHash | null = null): Promise<LedgerPage> {
  return callZome("ledger", "list_my_ledger", { before });
}

/// Collects any funds issued to the caller; returns how many grants.
export async function collectGrants(): Promise<number> {
  return callZome("ledger", "collect_grants", null);
}

// --- cashing out ---

/// The network's issuers, each with its published terms (or none yet).
export async function listIssuers(): Promise<IssuerView[]> {
  return callZome("ledger", "list_issuers", null);
}

/// Asks `issuer` to pay `amount` of the caller's balance out of the network.
/// `instructions` (where to pay, if the issuer needs telling) is sealed to
/// the issuer.
export async function cashOut(issuer: AgentPubKey, amount: number, instructions = ""): Promise<CashOutView> {
  return callZome("ledger", "cash_out", { issuer, amount, instructions });
}

/// The caller's cash-outs, newest first, each with where it stands.
export async function listMyCashOuts(): Promise<CashOutView[]> {
  return callZome("ledger", "list_my_cash_outs", null);
}

/// Takes back any cash-out its issuer declined; returns how many.
export async function reclaimDeclinedCashOuts(): Promise<number> {
  return callZome("ledger", "reclaim_declined_cash_outs", null);
}

/// The caller's signature showing an issuer's service they hold their key,
/// for one purpose -- over a fixed message for that purpose, issuer and the
/// service's nonce only.
export async function signIssuerLink(issuer: AgentPubKey, purpose: IssuerRequest, nonce: string): Promise<Uint8Array> {
  return callZome("ledger", "sign_issuer_link", { issuer, purpose, nonce });
}

