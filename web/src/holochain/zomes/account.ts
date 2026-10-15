// Accounts: a person's recovery plan, guardians vouching, and a new key
// taking an account over -- handed over from the old device, or recovered
// when it's lost. See the account zome, and RECOVERY.md.
import { callZome } from "../client";
import type { ActionHash, AgentPubKey, PlanView, RecoveryPlan, Succession, SuccessionView, VouchView } from "../types";

export async function setRecoveryPlan(plan: RecoveryPlan): Promise<PlanView> {
  return callZome("account", "set_recovery_plan", plan);
}

export async function myRecoveryPlan(): Promise<PlanView | null> {
  return callZome("account", "my_recovery_plan", null);
}

export async function recoveryPlanOf(account: AgentPubKey): Promise<PlanView | null> {
  return callZome("account", "recovery_plan_of", account);
}

/// The accounts a recovery phrase's key recovers.
export async function accountsForPhraseKey(key: AgentPubKey): Promise<PlanView[]> {
  return callZome("account", "accounts_for_phrase_key", key);
}

/// The accounts the caller guards.
export async function myWards(): Promise<PlanView[]> {
  return callZome("account", "my_wards", null);
}

/// The caller, a guardian, vouching that `successor` is the person behind
/// `account`.
export async function vouch(account: AgentPubKey, successor: AgentPubKey): Promise<ActionHash> {
  return callZome("account", "vouch", { account, successor });
}

export async function vouchesForMe(): Promise<VouchView[]> {
  return callZome("account", "vouches_for_me", null);
}

/// Hands the caller's account to `successor`, with `parcel` sealed to it.
export async function handOver(successor: AgentPubKey, parcel: string): Promise<ActionHash> {
  return callZome("account", "hand_over", { successor, parcel });
}

export async function takeOver(succession: Succession): Promise<ActionHash> {
  return callZome("account", "take_over", succession);
}

export async function mySuccession(): Promise<SuccessionView | null> {
  return callZome("account", "my_succession", null);
}

/// Every key that has taken over `account` -- none while it's in use.
export async function successionsOf(account: AgentPubKey): Promise<SuccessionView[]> {
  return callZome("account", "successions_of", account);
}

export async function latestActionOf(agent: AgentPubKey): Promise<ActionHash | null> {
  return callZome("account", "latest_action_of", agent);
}

export async function openParcels(): Promise<string[]> {
  return callZome("account", "open_parcels", null);
}

/// Asks `issuer` to reissue the balance of the account the caller recovered.
export async function requestReissue(issuer: AgentPubKey): Promise<void> {
  return callZome("account", "request_reissue", issuer);
}
