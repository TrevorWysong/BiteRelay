// How a store answers an order, as the app shows it: the window it has to
// accept (the DNA's `store_response_secs`) and why an order was cancelled
// (`Cancellation`). Validation checks every cancellation reason against who
// gave it, so these messages can say plainly what happened.
import type { Cancellation, DeclineReason } from "../holochain/types";

/// The reasons a store can give for turning an order down, in the order
/// its Decline menu lists them.
export const DECLINE_REASONS: readonly { reason: DeclineReason; label: string }[] = [
  { reason: "TooBusy", label: "Too busy" },
  { reason: "ItemsUnavailable", label: "Items unavailable" },
  { reason: "Closed", label: "Closed" },
  { reason: "OutdatedPrices", label: "Prices changed" },
  { reason: "Other", label: "Other" },
];

/// When the store's window to accept an order closes, in milliseconds since
/// the epoch: `windowSecs` after the order reached it -- `writtenAt`, its
/// latest version's timestamp in microseconds, as validation measures it.
export function responseDeadlineMs(writtenAt: number, windowSecs: number): number {
  return writtenAt / 1000 + windowSecs * 1000;
}

const STORE_REASONS: Record<DeclineReason, string> = {
  TooBusy: "The store is too busy to take this order right now.",
  ItemsUnavailable: "The store is out of something you ordered.",
  Closed: "The store is closed.",
  OutdatedPrices: "The store's prices changed since you ordered. Your cart has the new prices if you'd like to order again.",
  Other: "The store couldn't take this order.",
};

/// Why an order was cancelled, told to its customer.
export function cancellationText(cancellation: Cancellation | null): string {
  if (cancellation === null) return "This order was cancelled.";
  if (typeof cancellation === "object") return STORE_REASONS[cancellation.ByStore];
  switch (cancellation) {
    case "ByCustomer":
      return "You cancelled this order.";
    case "StoreDidNotRespond":
      return "The store didn't respond in time, so this order was cancelled. You weren't charged.";
  }
}
