// Delivery handoffs: the driver records each one (`recordLeg`) and the
// other party acknowledges it (`acknowledgeLeg`) -- see the attestation
// zome. Neither needs the other online at the same moment.
import { callZome } from "../client";
import type { ActionHash, AgentPubKey, GeoPoint, HandoffEvidence, HcRecord, LegKind } from "../types";

/// The driver recording a handoff as it happens -- collecting from the
/// store, or handing over to the customer.
export async function recordLeg(input: {
  order_ref: ActionHash;
  sequence: number;
  kind: LegKind;
  to: AgentPubKey;
  geo_at_completion: GeoPoint;
  photo_data_uri?: string;
  /// The customer's delivery PIN, if the driver asked for it.
  pin?: string | null;
}): Promise<HcRecord> {
  return callZome("attestation", "record_leg", { photo_data_uri: "", ...input });
}

/// The other party to a handoff acknowledging it, signed on their own
/// chain. Safe to repeat.
export async function acknowledgeLeg(legAction: ActionHash): Promise<HcRecord> {
  return callZome("attestation", "acknowledge_leg", legAction);
}

export async function getLegsForOrder(orderRef: ActionHash): Promise<HcRecord[]> {
  return callZome("attestation", "get_legs_for_order", orderRef);
}

export async function getReceiptForLeg(leg: ActionHash): Promise<HcRecord | null> {
  return callZome("attestation", "get_receipt_for_leg", leg);
}

/// Where a handoff happened and any photo -- sealed between its two parties,
/// so `null` for anyone else.
export async function getHandoffEvidence(leg: ActionHash): Promise<HandoffEvidence | null> {
  return callZome("attestation", "get_handoff_evidence", leg);
}

/// A handoff's evidence as shared with the caller, an arbitrator.
export async function getSharedEvidence(leg: ActionHash): Promise<HandoffEvidence | null> {
  return callZome("attestation", "get_shared_evidence", leg);
}
