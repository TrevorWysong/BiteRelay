import { callZome } from "../client";
import type { DeliveryCapability, GeoPoint, HcRecord, NearbyProvider } from "../types";

/// Real drivers refresh this every 45-60s while online, matching the
/// backend's own beacon TTL (90s) and bucket size (2min) -- see
/// `geo_presence_coordinator`'s doc comments. Refreshing faster wouldn't
/// help: Kitsune2's own gossip floor is roughly a minute, so a faster
/// beacon can't propagate any faster than the network already does.
export const PRESENCE_REFRESH_MS = 50_000;

export async function announceOnline(location: GeoPoint, capabilities: DeliveryCapability[]): Promise<HcRecord> {
  return callZome("geo_presence", "announce_online", { location, capabilities });
}

export async function announceOffline(): Promise<void> {
  return callZome("geo_presence", "announce_offline", null);
}

export async function getNearbyProviders(geohash: string): Promise<NearbyProvider[]> {
  return callZome("geo_presence", "get_nearby_providers", geohash);
}
