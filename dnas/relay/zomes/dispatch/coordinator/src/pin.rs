//! Handoff codes: how the giver proves a handoff -- the customer's at the
//! door, the store's at pickup.
//!
//! Each is a random PIN of `HANDOFF_CODE_DIGITS` digits and a salt. The order publishes only
//! `sha256(pin || salt)`; the giver keeps the PIN and salt sealed to
//! themselves, and their app shows them as a QR code (and the digits).
//! The driver scans it (`attestation::record_leg` with `scanned`), types the
//! digits for the giver's conductor to check (`attestation::handoff_by_code`),
//! or the giver confirms in their own app. A few digits are few, so nothing
//! that could test a guess is public: without the salt, the commitment says
//! nothing, and typed guesses are cut off after a few.

use dispatch_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{open, resolve_latest_decoded, seal};
use relay_integrity_support::limits::HANDOFF_CODE_DIGITS;
use sha2::{Digest, Sha256};

/// A fresh handoff code: its commitment, and the code sealed to the caller.
pub(crate) struct NewCode {
    pub commitment: Vec<u8>,
    pub sealed: XSalsa20Poly1305EncryptedData,
}

/// The commitment to a code: `sha256(pin || salt)`.
pub(crate) fn commit(secret: &PinSecret) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(secret.pin.as_bytes());
    hasher.update(&secret.salt);
    hasher.finalize().to_vec()
}

/// A fresh handoff code for the caller -- the customer's for a new
/// delivery, the store's as it accepts one.
pub(crate) fn new_code() -> ExternResult<NewCode> {
    let bytes = random_bytes(20)?;
    let number = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) % 10u32.pow(HANDOFF_CODE_DIGITS);
    let secret = PinSecret { pin: format!("{number:0width$}", width = HANDOFF_CODE_DIGITS as usize), salt: bytes[4..20].to_vec() };
    let me = agent_info()?.agent_initial_pubkey;
    Ok(NewCode { commitment: commit(&secret), sealed: seal(&me, &secret)? })
}

/// The caller's handoff code for a delivery -- the customer's, to show the
/// driver at the door. `None` if the order isn't theirs.
#[hdk_extern]
pub fn get_my_handover_code(order_original_action: ActionHash) -> ExternResult<Option<PinSecret>> {
    let (_, order): (_, DeliveryOrder) = resolve_latest_decoded(order_original_action, "DeliveryOrder")?;
    let me = agent_info()?.agent_initial_pubkey;
    if order.requester != me {
        return Ok(None);
    }
    open(&me, &order.sealed_pin)
}

/// The caller's pickup code for a delivery -- the store's, to show the
/// driver collecting it. `None` before it's accepted, or if it isn't theirs.
#[hdk_extern]
pub fn get_my_pickup_code(order_original_action: ActionHash) -> ExternResult<Option<PinSecret>> {
    let (_, order): (_, DeliveryOrder) = resolve_latest_decoded(order_original_action, "DeliveryOrder")?;
    let me = agent_info()?.agent_initial_pubkey;
    match order.sealed_pickup_code.filter(|_| order.merchant == me) {
        Some(sealed) => open(&me, &sealed),
        None => Ok(None),
    }
}
