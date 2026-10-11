// Delivery handoffs: the driver records each one (`recordLeg`), and the
// giver proves it -- the driver scans their code, they confirm in their own
// app (`acknowledgeLeg`), or the driver types the digits they read out
// (`handoffByCode`). See the attestation zome.
import { callZome } from "../client";
import type { ActionHash, AgentPubKey, GeoPoint, HandoffEvidence, HcRecord, LegKind, PinSecret } from "../types";

/// The driver recording a handoff as it happens -- collecting from the
/// store, or handing over to the customer.
export async function recordLeg(input: {
  order_ref: ActionHash;
  sequence: number;
  kind: LegKind;
  to: AgentPubKey;
  geo_at_completion: GeoPoint;
  photo_data_uri?: string;
  /// The giver's code, if the driver scanned it -- proof on its own.
  scanned?: PinSecret | null;
  /// Left at the door, on an order whose customer chose that.
  left_at_door?: boolean;
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

/// The driver proving a handoff with the six digits the giver read out --
/// checked by the giver's own app, which must be online. Returns the
/// giver's confirmation.
export async function handoffByCode(leg: ActionHash, code: string): Promise<ActionHash> {
  return callZome("attestation", "handoff_by_code", { leg, code });
}

/// The driver checking in at the store with its code (scanned or typed),
/// which the store's own app checks -- it needs the store's app online.
export async function checkInAtStore(orderRef: ActionHash, code: string): Promise<void> {
  return callZome("attestation", "check_in_at_store", { order_ref: orderRef, code });
}
