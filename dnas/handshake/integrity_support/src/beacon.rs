//! Proving a moment has passed, against the network's public time source
//! (`handshake_governance::TimeSource`, drand by default).
//!
//! Holochain checks only that an author's actions run forward in time, so a
//! record can be dated ahead of when it was really made -- and a deadline
//! rule that read a record's own timestamp would let anyone claim early. A
//! rule that matters to someone else instead takes a `Beacon`: a round
//! nobody could know before it was published, so the claim was made no
//! earlier. Its signature is checked against the network's public key -- no
//! network call, the same answer for every validator.

use drand_verify::{G2PubkeyRfc, Pubkey};
use hdi::prelude::*;
pub use handshake_types::Beacon;

/// When `beacon`'s round was published -- or why it isn't a round of the
/// network's time source.
pub fn beacon_time(beacon: &Beacon) -> Result<Timestamp, &'static str> {
    let source = handshake_governance::time_source();
    let key: [u8; 96] = decode_hex(&source.public_key).and_then(|k| k.try_into().ok()).ok_or("the network's time source has no valid key")?;
    let key = G2PubkeyRfc::from_fixed(key).map_err(|_| "the network's time source has no valid key")?;
    if beacon.round == 0 || !key.verify(beacon.round, b"", &beacon.signature).unwrap_or(false) {
        return Err("that isn't a round of the network's time source");
    }
    let secs = source.genesis_secs.checked_add((beacon.round - 1).checked_mul(source.period_secs).ok_or("that round is out of range")?).ok_or("that round is out of range")?;
    i64::try_from(secs).ok().and_then(|s| s.checked_mul(1_000_000)).map(Timestamp::from_micros).ok_or("that round is out of range")
}

/// Whether `beacon` proves `deadline` has passed -- or why not.
pub fn proves_past(beacon: Option<&Beacon>, deadline: Timestamp) -> Result<(), &'static str> {
    let beacon = beacon.ok_or("this needs proof of the time, from the network's time source")?;
    if beacon_time(beacon)? < deadline {
        return Err("it's too early for that");
    }
    Ok(())
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A quicknet round, as published.
    fn round() -> Beacon {
        Beacon { round: 32_961_525, signature: decode_hex("a6e377b61217fba318ea00d4b017c451077db70175514968d12697b8e4b0721962a2267a4b59cf1a431461d8f8717fdd").unwrap() }
    }

    #[test]
    fn a_published_round_dates_itself() {
        let at = beacon_time(&round()).unwrap();
        assert_eq!(at.as_micros(), (1_692_803_367 + (32_961_525 - 1) * 3) * 1_000_000);
    }

    #[test]
    fn a_round_is_checked_against_its_signature() {
        assert!(beacon_time(&Beacon { round: 32_961_526, ..round() }).is_err(), "another round's signature");
        assert!(beacon_time(&Beacon { signature: vec![0; 48], ..round() }).is_err(), "no signature at all");
    }

    #[test]
    fn it_proves_only_what_has_passed() {
        let at = beacon_time(&round()).unwrap();
        assert!(proves_past(Some(&round()), at).is_ok());
        assert!(proves_past(Some(&round()), Timestamp::from_micros(at.as_micros() + 1)).is_err());
        assert!(proves_past(None, Timestamp::from_micros(0)).is_err());
    }
}
