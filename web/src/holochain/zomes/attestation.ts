import { callZome } from "../client";
import type { ActionHash, AgentPubKey, GeoPoint, HcRecord, LegKind } from "../types";

export async function recordLeg(input: {
  order_ref: ActionHash;
  sequence: number;
  kind: LegKind;
  to: AgentPubKey;
  geo_at_completion: GeoPoint;
  photo_data_uri?: string;
}): Promise<HcRecord> {
  return callZome("attestation", "record_leg", { photo_data_uri: "", ...input });
}

/// Orchestrates the full countersigning round trip server-side (both
/// preflight-accept and both dual commits happen inside this single zome
/// call, including a real network call to the counterparty) -- the caller
/// doesn't drive a multi-step signing UI, just calls this once after
/// `recordLeg` and awaits the result. Either party on the leg may call it.
///
/// This does NOT, by itself, make the receipt discoverable -- callers must
/// also call `linkLegToReceipt` afterward (see its own doc comment for why
/// that can't happen inside this same call). Skipping that second call is
/// a real, silent trap: the countersigned receipt still commits
/// successfully on both chains with no error here, but
/// `complete_delivery` later fails with "0 of N required leg attestations
/// found" since its discoverability check has nothing to find -- confirmed
/// directly by driving the real UI end to end in a browser, not assumed.
export async function initiateLegAttestation(legAction: ActionHash): Promise<HcRecord> {
  return callZome("attestation", "initiate_leg_attestation", legAction);
}

/// The required second step after `initiateLegAttestation` -- see that
/// function's own doc comment. `receipt` is the action hash of the record
/// `initiateLegAttestation` returned.
export async function linkLegToReceipt(leg: ActionHash, receipt: ActionHash): Promise<void> {
  return callZome("attestation", "link_leg_to_receipt", { leg, receipt });
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
