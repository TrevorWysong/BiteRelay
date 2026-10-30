// How a store answers an order, as the app shows it: the window it has to
// accept (the DNA's `store_response_secs`) and why an order was cancelled
// (`Cancellation`). Validation checks every cancellation reason against who
// gave it, so these messages can say plainly what happened.
import type { Cancellation, DeclineReason } from "../../holochain/types";
import { t } from "../../i18n";

/// The reasons a store can give for turning an order down, in the order
/// its Decline menu lists them.
export const DECLINE_REASONS: readonly DeclineReason[] = ["TooBusy", "ItemsUnavailable", "Closed", "OutdatedPrices", "BagHoldLapsed", "TermsChanged", "Other"];

/// A decline reason's short name, as the store picks it.
export const declineLabel = (reason: DeclineReason): string => t(`decline.label.${reason}`);

/// When the store's window to accept an order closes, in milliseconds since
/// the epoch: `windowSecs` after the order reached it -- `writtenAt`, its
/// latest version's timestamp in microseconds, as validation measures it.
export function responseDeadlineMs(writtenAt: number, windowSecs: number): number {
  return writtenAt / 1000 + windowSecs * 1000;
}

export function cancellationText(cancellation: Cancellation | null): string {
  if (cancellation === null) return t("cancel.unknown");
  if (typeof cancellation === "object") return t(`decline.reason.${cancellation.ByStore}`);
  return t(`cancel.${cancellation}`);
}
