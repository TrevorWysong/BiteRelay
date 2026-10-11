// How long a delivery would take a driver, for the ETAs their bid states:
// there to the store, waiting if the kitchen won't be ready yet, then on to
// the drop-off -- at the driver's own usual speed. A store starts cooking a
// delivery once its driver commits, so before then the food's ready its
// quoted prep time after the driver's bid would be accepted -- about now.
import type { GeoPoint } from "../holochain/types";
import { distanceKm } from "./geohash";

export interface Trip {
  /// Where the driver is.
  from: GeoPoint;
  store: GeoPoint;
  dropoff: GeoPoint;
  /// The driver's usual speed, door to door, in km/h.
  speedKmh: number;
  /// When the kitchen says the order will be ready (microseconds), once it's
  /// cooking.
  readyBy: number | null;
  /// The prep time the store quoted, for an order it hasn't started.
  prepMinutes: number | null;
  /// Now, in milliseconds.
  nowMs: number;
}

/// A bid's two ETAs, in whole minutes -- each at least one.
export interface TripEstimate {
  /// Until the driver reaches the store: when they'd be due there.
  toStoreMinutes: number;
  /// Until they'd hand the order over.
  etaMinutes: number;
}

export function estimateTrip(trip: Trip): TripEstimate {
  const minutesFor = (km: number) => (km / Math.max(trip.speedKmh, 1)) * 60;
  const toStore = minutesFor(distanceKm(trip.from, trip.store));
  const untilReady = trip.readyBy !== null ? Math.max(0, (trip.readyBy / 1000 - trip.nowMs) / 60_000) : (trip.prepMinutes ?? 0);
  const toDropoff = minutesFor(distanceKm(trip.store, trip.dropoff));
  const toStoreMinutes = Math.max(1, Math.ceil(toStore));
  return { toStoreMinutes, etaMinutes: Math.max(toStoreMinutes, Math.ceil(Math.max(toStore, untilReady) + toDropoff)) };
}
