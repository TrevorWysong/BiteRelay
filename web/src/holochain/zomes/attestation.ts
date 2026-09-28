import { callZome } from "../client";
import type { ActionHash, AgentPubKey, GeoPoint, HcRecord, LegKind } from "../types";

export async function recordLeg(input: {
  order_ref: ActionHash;
  sequence: number;
  kind: LegKind;
  to: AgentPubKey;
  geo_at_completion: GeoPoint;
}): Promise<HcRecord> {
  return callZome("attestation", "record_leg", input);
}

/// Orchestrates the full countersigning round trip server-side (both
/// preflight-accept and both dual commits happen inside this single zome
/// call, including a real network call to the counterparty) -- the caller
/// doesn't drive a multi-step signing UI, just calls this once after
/// `recordLeg` and awaits the result. Either party on the leg may call it.
export async function initiateLegAttestation(legAction: ActionHash): Promise<HcRecord> {
  return callZome("attestation", "initiate_leg_attestation", legAction);
}

export async function getLegsForOrder(orderRef: ActionHash): Promise<HcRecord[]> {
  return callZome("attestation", "get_legs_for_order", orderRef);
}

export async function getReceiptForLeg(leg: ActionHash): Promise<HcRecord | null> {
  return callZome("attestation", "get_receipt_for_leg", leg);
}

export async function listAttestedReceiptsForOrder(orderRef: ActionHash): Promise<ActionHash[]> {
  return callZome("attestation", "list_attested_receipts_for_order", orderRef);
}
