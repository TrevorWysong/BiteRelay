import { callZome } from "../client";
import type { ActionHash, AgentPubKey, CardView, ProgramStats, ProgramView, RewardsProgram } from "../types";

/// A store's rewards program at its current version -- `null` if it has none.
export async function programOf(catalogRef: ActionHash): Promise<ProgramView | null> {
  return callZome("rewards", "program_of", catalogRef);
}

/// Sets up or changes the caller's store's program.
export async function saveProgram(program: RewardsProgram): Promise<ActionHash> {
  return callZome("rewards", "save_program", program);
}

/// The caller's card at a store, with its program.
export async function myCard(catalogRef: ActionHash): Promise<CardView> {
  return callZome("rewards", "my_card", catalogRef);
}

/// Every card the caller holds. Collects any points stores have given, and
/// takes back points spent on a checkout that never became an order, first.
export async function myCards(): Promise<CardView[]> {
  await Promise.allSettled([callZome("rewards", "collect_grants", null), callZome("rewards", "reclaim_unspent", null)]);
  return callZome("rewards", "my_cards", null);
}

export async function collectGrants(): Promise<number> {
  return callZome("rewards", "collect_grants", null);
}

/// The caller's store giving a customer points.
export async function grantPoints(input: { to: AgentPubKey; catalog_ref: ActionHash; points: number; note: string }): Promise<ActionHash> {
  return callZome("rewards", "grant_points", input);
}

export async function programStats(catalogRef: ActionHash): Promise<ProgramStats> {
  return callZome("rewards", "program_stats", catalogRef);
}

export async function myBirthMonth(): Promise<number | null> {
  return callZome("rewards", "my_birth_month", null);
}

/// Once, ever.
export async function setBirthMonth(month: number): Promise<void> {
  return callZome("rewards", "set_birth_month", month);
}
