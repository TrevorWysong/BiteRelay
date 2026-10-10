// What a driver has taken on, and whether they can take one more order --
// the rule validation holds every pickup to (`dispatch_types::InHand`),
// applied here to the orders they're assigned too, as accepting a bid is.
import type { InHand } from "../holochain/types";

export type CarryRefusal = "CarryingPriority" | "PriorityGoesAlone" | "AtLimit";

/// Why a driver with `load` can't take an order (a priority one, if
/// `priority`) with at most `max` at once -- `null` if they can.
export function carryRefusal(load: InHand, priority: boolean, max: number): CarryRefusal | null {
  if (load.priority) return "CarryingPriority";
  if (priority && load.orders > 0) return "PriorityGoesAlone";
  if (load.orders >= max) return "AtLimit";
  return null;
}

/// A driver's other orders, for a customer weighing their bid.
export function describeLoad(load: InHand): string {
  if (load.orders === 0) return "No other orders";
  return `Delivering ${load.orders} other order${load.orders === 1 ? "" : "s"}`;
}

/// Why a customer can't choose this driver, in their words.
export const CUSTOMER_REFUSAL: Record<CarryRefusal, string> = {
  CarryingPriority: "On a priority delivery",
  PriorityGoesAlone: "Has other orders",
  AtLimit: "Has as many orders as they can carry",
};
