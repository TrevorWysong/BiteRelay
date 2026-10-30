// A suggested order of stops for a driver carrying several deliveries.
//
// Greedy nearest-neighbour from the driver's position, under the one rule
// that matters: a delivery's pickup comes before its drop-off. It isn't an
// optimal route (that's a travelling-salesman problem, and real road
// distances aren't available here) -- with the handful of deliveries one
// driver carries, it's a sensible, predictable order, and the UI labels it
// as a suggestion.
import { distanceKm } from "../places/geohash";
import type { GeoPoint } from "../../holochain/types";

export interface RouteDelivery {
  /// Identifies the delivery (an order hex).
  id: string;
  /// The store's location; `null` once the order's been picked up.
  pickup: GeoPoint | null;
  dropoff: GeoPoint;
}

export interface Stop {
  id: string;
  kind: "pickup" | "dropoff";
  at: GeoPoint;
  /// Straight-line distance from the previous stop (or the driver).
  legKm: number;
}

export function planRoute(start: GeoPoint, deliveries: RouteDelivery[]): Stop[] {
  // Every stop that's currently allowed: a pickup not yet made, or the
  // drop-off of something already on board.
  const pendingPickups = new Map(deliveries.filter((d) => d.pickup).map((d) => [d.id, d]));
  const onBoard = new Map(deliveries.filter((d) => !d.pickup).map((d) => [d.id, d]));
  const stops: Stop[] = [];
  let here = start;
  while (pendingPickups.size || onBoard.size) {
    const candidates: Omit<Stop, "legKm">[] = [
      ...[...pendingPickups.values()].map((d) => ({ id: d.id, kind: "pickup" as const, at: d.pickup! })),
      ...[...onBoard.values()].map((d) => ({ id: d.id, kind: "dropoff" as const, at: d.dropoff })),
    ];
    let best = candidates[0];
    let bestKm = distanceKm(here, best.at);
    for (const candidate of candidates.slice(1)) {
      const km = distanceKm(here, candidate.at);
      // Ties go to the earlier candidate (pickups first), keeping the order
      // stable between renders.
      if (km < bestKm) {
        best = candidate;
        bestKm = km;
      }
    }
    stops.push({ ...best, legKm: bestKm });
    here = best.at;
    if (best.kind === "pickup") {
      const delivery = pendingPickups.get(best.id)!;
      pendingPickups.delete(best.id);
      onBoard.set(best.id, delivery);
    } else {
      onBoard.delete(best.id);
    }
  }
  return stops;
}
