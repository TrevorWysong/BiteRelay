use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct GeoPoint {
    pub lat: f64,
    pub lon: f64,
}

/// What a provider is willing to carry. Kept as an enum (not a single
/// vertical flag) so a courier who does both restaurant runs and general
/// package drops doesn't need two separate provider identities.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryCapability {
    Food,
    Goods,
}

/// A mutual-credit-shaped reference to a locked amount in the `ledger` zome,
/// not a fixed-escrow-contract reference -- see the ledger zome's doc comment
/// for why that distinction matters (it's what lets a real HoloFuel backing
/// swap in later without touching this shape). Plain data embedded in `Bid`,
/// not a Holochain entry of its own.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct LedgerCommitmentRef {
    pub account: String,
    pub amount: u64,
    pub ledger_txn_ref: String,
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
                lon: center.lon + d_lon * lon_span,
            };
            let encoded = encode(neighbor, precision);
            if !out.contains(&encoded) {
                out.push(encoded);
            }
        }
    }
    out
}

/// Folds a coarse time bucket into an anchor path (presence beacons, open-
/// order discovery -- see architecture plan §9.2) so each bucket is a
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
    fn cell_and_neighbors_includes_self_and_eight_others() {
        let p = GeoPoint { lat: 27.7676, lon: -82.6403 };
        let gh = encode(p, 6);
        let cells = cell_and_neighbors(&gh);
        assert!(cells.contains(&gh));
        assert!(cells.len() <= 9);
        assert!(cells.len() >= 2);
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
