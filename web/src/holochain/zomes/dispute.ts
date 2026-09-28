import { callZome } from "../client";
import type { ActionHash, DisputeOutcome, HcRecord } from "../types";

/// Called by an arbitrator (rejected by `dispute_integrity::validate()` for
/// anyone else) after reviewing a case raised via `dispatch::raise_dispute`
/// / `raise_cancellation_dispute`. `dispatch::apply_dispute_resolution` /
/// `apply_cancellation_dispute_resolution` is the separate, subsequent call
/// that actually settles payment/reputation once this has landed.
export async function submitResolution(input: {
  dispute_original_action: ActionHash;
  outcome: DisputeOutcome;
  reasoning: string;
}): Promise<HcRecord> {
  return callZome("dispute", "submit_resolution", input);
}

export async function getDispute(disputeOriginalAction: ActionHash): Promise<HcRecord> {
  return callZome("dispute", "get_dispute", disputeOriginalAction);
}

export async function getDisputeForOrder(orderRef: ActionHash): Promise<HcRecord | null> {
  return callZome("dispute", "get_dispute_for_order", orderRef);
}

export interface OpenDisputesPage {
  disputes: HcRecord[];
  next_after: number | null;
}

export async function listOpenDisputes(after: number | null = null): Promise<OpenDisputesPage> {
  return callZome("dispute", "list_open_disputes", { after });
}
