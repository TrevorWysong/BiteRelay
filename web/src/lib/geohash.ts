// Standard geohash encoding (base32), matching the precision-6 cells the
// backend's anchors are keyed on (~1.2km cells -- see architecture plan §3
// and §9.2). This has to produce the *same* string the Rust side derives
// for the same lat/lon, since discovery is entirely anchor-based -- there
// is no server to reconcile a client-side encoding mismatch against.
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

const EARTH_RADIUS_KM = 6371;

/// Great-circle distance in kilometers -- used client-side only (order
/// batching's route-aware sort in the driver dashboard), never sent to or
/// compared against anything the backend validates. Deliberately kept out
/// of any zome: there's no way to deterministically recompute "is this a
/// good route" inside `validate()`, and real route optimization is a named,
/// accepted v2 gap (architecture plan §7) -- this is just a client-side
/// convenience sort, not a server-enforced guarantee.
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function encodeGeohash(lat: number, lon: number, precision = 6): string {
  let latRange = [-90, 90];
  let lonRange = [-180, 180];
  let hash = "";
  let bit = 0;
  let ch = 0;
  let evenBit = true;

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lonRange[0] + lonRange[1]) / 2;
      if (lon > mid) {
        ch |= 1 << (4 - bit);
        lonRange[0] = mid;
      } else {
        lonRange[1] = mid;
      }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2;
      if (lat > mid) {
        ch |= 1 << (4 - bit);
        latRange[0] = mid;
      } else {
        latRange[1] = mid;
      }
    }
    evenBit = !evenBit;
    if (bit < 4) {
      bit++;
    } else {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}
