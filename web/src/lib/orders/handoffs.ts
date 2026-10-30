// The two people on each side of a delivery handoff, in the app: the
// customer confirming their order reached them, and the store confirming
// it handed the order to the driver.
import { acknowledgeLeg, getLegsForOrder, getReceiptForLeg } from "../../holochain/zomes/attestation";
import { completeDelivery } from "../../holochain/zomes/dispatch";
import { actionHash, decodeEntry } from "../../holochain/decode";
import type { Leg, LegKind } from "../../holochain/types";
import { t } from "../../i18n";

/// The driver's most recent handoff of `kind` on an order, if it's reached
/// this device yet.
async function latestLeg(orderRef: Uint8Array, kind: LegKind): Promise<Uint8Array | null> {
  const legs = (await getLegsForOrder(orderRef)).map((record) => ({ hash: actionHash(record), leg: decodeEntry<Leg>(record) })).filter((l) => l.leg.kind === kind);
  legs.sort((a, b) => b.leg.completed_at - a.leg.completed_at);
  return legs[0]?.hash ?? null;
}

/// Thrown while the driver's drop-off hasn't reached this device yet --
/// usually seconds; worth retrying.
export class HandoffNotYetHere extends Error {}

/// The customer confirming they received their delivery: acknowledges the
/// driver's drop-off (their own signed receipt), then completes the order,
/// which pays for it.
export async function confirmDeliveryReceived(orderRef: Uint8Array): Promise<void> {
  const dropoff = await latestLeg(orderRef, "CustomerHandoff");
  if (!dropoff) throw new HandoffNotYetHere(t("handoff.notYet"));
  await acknowledgeLeg(dropoff);
  await completeDelivery(orderRef);
}

/// The driver's pickup from the store, if it's waiting for the store to
/// confirm it handed the order over.
export async function unconfirmedPickup(orderRef: Uint8Array): Promise<Uint8Array | null> {
  const pickup = await latestLeg(orderRef, "MerchantHandoff");
  if (!pickup) return null;
  return (await getReceiptForLeg(pickup)) ? null : pickup;
}
