use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct GeoPoint {
    pub lat: f64,
    pub lon: f64,
}

impl GeoPoint {
    /// Whether this is a real place: finite, latitude within ±90 and
    /// longitude within ±180. Anything else (NaN included) would slip past
    /// every distance comparison.
    pub fn is_valid(&self) -> bool {
        self.lat.is_finite() && self.lon.is_finite() && (-90.0..=90.0).contains(&self.lat) && (-180.0..=180.0).contains(&self.lon)
    }
}

const EARTH_RADIUS_KM: f64 = 6371.0;

/// Great-circle (haversine) distance in kilometers -- ported line-for-line
/// from `web/src/lib/geohash.ts`'s own `distanceKm` (used there for the
/// driver dashboard's client-side route sort) so the client-side delivery-
/// radius pre-check and this zome's own deterministic enforcement
/// (`dispatch_integrity::validate_new_order`) can never disagree about
/// what "within range" means.
///
/// Safe to call from `validate()`: `sin`/`cos`/`asin`/`sqrt` on
/// `wasm32-unknown-unknown` are implemented by the pure-Rust `libm` crate
/// (there's no OS to link a native, platform-varying libm against on this
/// target), so every peer's wasm runtime computes the exact same
/// bit-for-bit result for the same inputs -- the same determinism
/// guarantee every other piece of arithmetic in this codebase's own
/// `validate()` callbacks already relies on, just applied to trigonometry
/// for the first time here.
pub fn distance_km(a: GeoPoint, b: GeoPoint) -> f64 {
    let to_rad = |deg: f64| deg * std::f64::consts::PI / 180.0;
    let d_lat = to_rad(b.lat - a.lat);
    let d_lon = to_rad(b.lon - a.lon);
    let sin_lat = (d_lat / 2.0).sin();
    let sin_lon = (d_lon / 2.0).sin();
    let h = sin_lat * sin_lat + to_rad(a.lat).cos() * to_rad(b.lat).cos() * sin_lon * sin_lon;
    2.0 * EARTH_RADIUS_KM * h.sqrt().min(1.0).asin()
}

/// What a provider is willing to carry. Kept as an enum (not a single
/// vertical flag) so a courier who does both restaurant runs and general
/// package drops doesn't need two separate provider identities.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryCapability {
    Food,
    Goods,
}

const BASE32: &[u8] = b"0123456789bcdefghjkmnpqrstuvwxyz";

/// Standard interleaved-bit geohash encoding. `precision` is the number of
/// base32 characters -- 5-6 is the coarse precision this app uses for
/// presence beacons and merchant discovery (city-block scale), never per-GPS-tick data.
pub fn encode(point: GeoPoint, precision: usize) -> String {
    let mut lat_range = (-90.0_f64, 90.0_f64);
    let mut lon_range = (-180.0_f64, 180.0_f64);
    let mut is_even = true;
    let mut bit = 0u8;
    let mut ch = 0u8;
    let mut out = String::with_capacity(precision);

    while out.len() < precision {
        if is_even {
            let mid = (lon_range.0 + lon_range.1) / 2.0;
            if point.lon > mid {
                ch |= 1 << (4 - bit);
                lon_range.0 = mid;
            } else {
                lon_range.1 = mid;
            }
        } else {
            let mid = (lat_range.0 + lat_range.1) / 2.0;
            if point.lat > mid {
                ch |= 1 << (4 - bit);
                lat_range.0 = mid;
            } else {
                lat_range.1 = mid;
            }
        }
        is_even = !is_even;
        if bit < 4 {
            bit += 1;
        } else {
            out.push(BASE32[ch as usize] as char);
            bit = 0;
            ch = 0;
        }
    }
    out
}

/// Returns (lat_min, lat_max, lon_min, lon_max) for a geohash string.
pub fn bounding_box(geohash: &str) -> Option<(f64, f64, f64, f64)> {
    let mut lat_range = (-90.0_f64, 90.0_f64);
    let mut lon_range = (-180.0_f64, 180.0_f64);
    let mut is_even = true;

    for c in geohash.chars() {
        let idx = BASE32.iter().position(|&b| b as char == c)? as u8;
        for n in (0..5).rev() {
            let bit = (idx >> n) & 1;
            if is_even {
                let mid = (lon_range.0 + lon_range.1) / 2.0;
                if bit == 1 {
                    lon_range.0 = mid;
                } else {
                    lon_range.1 = mid;
                }
            } else {
                let mid = (lat_range.0 + lat_range.1) / 2.0;
                if bit == 1 {
                    lat_range.0 = mid;
                } else {
                    lat_range.1 = mid;
                }
            }
            is_even = !is_even;
        }
    }
    Some((lat_range.0, lat_range.1, lon_range.0, lon_range.1))
}

/// The 8 neighboring cells plus the cell itself, at the same precision as the
/// input. Used so a candidate-provider search doesn't miss someone one cell
/// over from a boundary edge. Computed by decoding to a bounding box, walking
/// to each of the 8 adjacent box centers, and re-encoding -- simpler and less
/// error-prone than the classic bit-flip neighbor algorithm, at the cost of
/// relying on floating point cell-width math.
/// Wraps a longitude into `[-180, 180)` -- `encode`/`bounding_box` both treat
/// longitude as bounded to that range and never wrap, so a value computed
/// slightly outside it (e.g. a neighbor cell just past the antimeridian)
/// needs normalizing before re-encoding.
fn wrap_lon(lon: f64) -> f64 {
    (lon + 180.0).rem_euclid(360.0) - 180.0
}

pub fn cell_and_neighbors(geohash: &str) -> Vec<String> {
    let precision = geohash.chars().count();
    let Some((lat_min, lat_max, lon_min, lon_max)) = bounding_box(geohash) else {
        return vec![geohash.to_string()];
    };
    let lat_span = lat_max - lat_min;
    let lon_span = lon_max - lon_min;
    let center = GeoPoint {
        lat: (lat_min + lat_max) / 2.0,
        lon: (lon_min + lon_max) / 2.0,
    };

    let mut out = vec![geohash.to_string()];
    for d_lat in [-1.0, 0.0, 1.0] {
        for d_lon in [-1.0, 0.0, 1.0] {
            if d_lat == 0.0 && d_lon == 0.0 {
                continue;
            }
            let neighbor = GeoPoint {
                lat: (center.lat + d_lat * lat_span).clamp(-90.0, 90.0),
                // Wrapped, not clamped -- unlike latitude, longitude has no
                // poles to clamp against: a cell just east of the antimeridian
                // (lon near +180) has a real neighbor just west of it (lon near
                // -180), not a nonexistent "lon > 180" cell. Clamping there
                // would silently miss that neighbor for every cell straddling
                // the date line.
                lon: wrap_lon(center.lon + d_lon * lon_span),
            };
            let encoded = encode(neighbor, precision);
            if !out.contains(&encoded) {
                out.push(encoded);
            }
        }
    }
    out
}

/// Folds a coarse time bucket into an anchor path (open-order discovery) so
/// each bucket is a
/// *distinct* base hash with a naturally bounded link set, rather than one
/// anchor per geohash cell accumulating links forever. Readers should query
/// `time_bucket(now, b)` and `time_bucket(now, b) - 1` (the immediately
/// preceding bucket) to avoid missing something published just before a
/// bucket boundary. Takes plain millisecond `i64`s rather than
/// `holochain_timestamp::Timestamp` so this crate stays hdi/hdk-independent
/// -- callers pass `sys_time()?.as_millis()`.
pub fn time_bucket(now_millis: i64, bucket_millis: i64) -> i64 {
    now_millis / bucket_millis
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_point_is_valid_only_on_the_globe() {
        assert!(GeoPoint { lat: 27.77, lon: -82.64 }.is_valid());
        assert!(!GeoPoint { lat: f64::NAN, lon: 0.0 }.is_valid());
        assert!(!GeoPoint { lat: 91.0, lon: 0.0 }.is_valid());
        assert!(!GeoPoint { lat: 0.0, lon: f64::INFINITY }.is_valid());
    }

    #[test]
    fn the_distance_to_a_cell_is_to_its_nearest_edge() {
        let here = GeoPoint { lat: 27.7676, lon: -82.6403 };
        let cell = encode(here, 5);
        assert_eq!(distance_to_cell_km(here, &cell), Some(0.0), "inside the cell");
        let far = encode(GeoPoint { lat: 40.7128, lon: -74.006 }, 5);
        let d = distance_to_cell_km(here, &far).unwrap();
        assert!(d > 1_400.0 && d < 1_700.0, "St. Petersburg to New York's cell: {d}");
        assert_eq!(distance_to_cell_km(here, "not a geohash!"), None);
        assert_eq!(distance_to_cell_km(here, ""), None);
    }
    use super::*;

    #[test]
    fn encode_is_deterministic_and_right_length() {
        let p = GeoPoint { lat: 27.7676, lon: -82.6403 }; // St. Petersburg, FL
        let gh = encode(p, 6);
        assert_eq!(gh.len(), 6);
        assert_eq!(gh, encode(p, 6));
    }

    #[test]
    fn bounding_box_contains_the_original_point() {
        let p = GeoPoint { lat: 27.7676, lon: -82.6403 };
        let gh = encode(p, 6);
        let (lat_min, lat_max, lon_min, lon_max) = bounding_box(&gh).unwrap();
        assert!(p.lat >= lat_min && p.lat <= lat_max);
        assert!(p.lon >= lon_min && p.lon <= lon_max);
    }

    #[test]
    fn distance_km_is_zero_for_the_same_point() {
        let p = GeoPoint { lat: 27.7676, lon: -82.6403 };
        assert_eq!(distance_km(p, p), 0.0);
    }

    #[test]
    fn distance_km_matches_a_known_reference_distance() {
        // One degree of latitude at the equator is ~111.19km -- a standard
        // reference value, not something re-derived from this function's
        // own logic.
        let a = GeoPoint { lat: 0.0, lon: 0.0 };
        let b = GeoPoint { lat: 1.0, lon: 0.0 };
        let d = distance_km(a, b);
        assert!((d - 111.19).abs() < 0.1, "expected ~111.19km, got {d}");
    }

    #[test]
    fn distance_km_is_symmetric() {
        let a = GeoPoint { lat: 27.7676, lon: -82.6403 };
        let b = GeoPoint { lat: 40.7128, lon: -74.0060 };
        assert_eq!(distance_km(a, b), distance_km(b, a));
    }

    #[test]
    fn cell_and_neighbors_includes_self_and_eight_others() {
        let p = GeoPoint { lat: 27.7676, lon: -82.6403 };
        let gh = encode(p, 6);
        let cells = cell_and_neighbors(&gh);
        assert!(cells.contains(&gh));
        assert!(cells.len() <= 9);
        assert!(cells.len() >= 2);
    }

    #[test]
    fn cell_and_neighbors_wraps_across_the_antimeridian() {
        let p = GeoPoint { lat: 0.0, lon: 179.9999 };
        let gh = encode(p, 6);
        let cells = cell_and_neighbors(&gh);
        // A neighbor east of this cell crosses from +180 to -180 -- without
        // wrapping, that neighbor's longitude would stay stuck above +180,
        // re-encoding to the same easternmost cell instead of the real one
        // just past the date line.
        let wrapped_neighbor = encode(GeoPoint { lat: 0.0, lon: -179.9999 }, 6);
        assert!(cells.contains(&wrapped_neighbor));
    }

    #[test]
    fn time_bucket_separates_timestamps_further_apart_than_the_bucket_size() {
        let bucket_millis = 120_000; // 2 minutes, matching presence beacons' bucket size
        let t0 = 1_700_000_000_000_i64;
        let t_same_bucket = t0 + 1_000; // 1s later -- same bucket
        let t_next_bucket = t0 + bucket_millis; // exactly one bucket later -- different bucket
        assert_eq!(time_bucket(t0, bucket_millis), time_bucket(t_same_bucket, bucket_millis));
        assert_ne!(time_bucket(t0, bucket_millis), time_bucket(t_next_bucket, bucket_millis));
        // The immediately preceding bucket is always exactly bucket - 1 -- what
        // readers rely on to also check "the previous bucket" without a second helper.
        assert_eq!(time_bucket(t_next_bucket, bucket_millis) - 1, time_bucket(t0, bucket_millis));
    }
}

/// A handoff code: what the giving party's app shows as a QR code (and, as
/// six digits, to read out) at a handoff -- the store's to the driver at
/// pickup, the customer's to the driver at the door. The order publishes
/// only `sha256(pin || salt)`; without the salt, nobody can test guesses
/// against it. Revealed (scanned), it proves the giver handed the order
/// over.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PinSecret {
    pub pin: String,
    pub salt: Vec<u8>,
}

impl PinSecret {
    /// Its commitment, as an order publishes it: `sha256(pin || salt)`.
    pub fn commitment(&self) -> Vec<u8> {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(self.pin.as_bytes());
        hasher.update(&self.salt);
        hasher.finalize().to_vec()
    }

    /// Whether it's the code behind `commitment`.
    pub fn opens(&self, commitment: &[u8]) -> bool {
        commitment.len() == 32 && self.commitment() == commitment
    }
}

/// A round of the network's public time source (`relay_governance::TimeSource`):
/// its number and the signature published for it. A record carrying one
/// wasn't made before that round was published -- the proof a deadline
/// claim makes that its deadline has passed.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Beacon {
    pub round: u64,
    pub signature: Vec<u8>,
}

/// The shortest distance from `point` to anywhere in a geohash cell, in
/// kilometres -- 0 inside it. `None` if `geohash` isn't one. What a rule
/// that sees only the cell (a delivery's public drop-off area) can check
/// against a distance: the cell's nearest edge is the best case.
pub fn distance_to_cell_km(point: GeoPoint, geohash: &str) -> Option<f64> {
    if geohash.is_empty() {
        return None;
    }
    let (lat_min, lat_max, lon_min, lon_max) = bounding_box(geohash)?;
    let nearest = GeoPoint { lat: point.lat.clamp(lat_min, lat_max), lon: point.lon.clamp(lon_min, lon_max) };
    Some(distance_km(point, nearest))
}
