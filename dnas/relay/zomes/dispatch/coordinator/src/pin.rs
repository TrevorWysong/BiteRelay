//! The delivery PIN: proof a delivery reached the customer, for the store
//! and driver to answer a "never arrived" claim with.
//!
//! At checkout the customer's app picks a random 6-digit PIN and salt. The
//! order publishes only `sha256(pin || salt)`; the PIN and salt are sealed
//! to the customer (to show at the door) and to each arbitrator. At the
//! door the customer reads the PIN out and the driver records it, sealed to
//! the arbitrators (`attestation::record_leg`). An arbitrator checks the
//! two against the commitment: a match is proof the customer -- or someone
//! holding their phone -- was there.
//!
//! Six digits are few, so nothing that could test a guess is ever public:
//! without the salt, the commitment says nothing, and only the customer and
//! the arbitrators hold it. A driver can't find the PIN by trying them all.

use attestation_types::{Leg, LegKind};
use dispatch_integrity::*;
use dispute_types::{ArbitratorSeal, PinSecret};
use hdk::prelude::*;
use relay_coordinator_support::{open, open_my_seal, resolve_latest_decoded, seal, seal_to_arbitrators};
use sha2::{Digest, Sha256};

/// What a new delivery carries for its PIN.
pub(crate) struct NewPin {
    pub commitment: Vec<u8>,
    pub sealed_pin: XSalsa20Poly1305EncryptedData,
    pub for_arbitrators: Vec<ArbitratorSeal>,
}

/// The commitment to a PIN: `sha256(pin || salt)`.
pub(crate) fn commit(secret: &PinSecret) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(secret.pin.as_bytes());
    hasher.update(&secret.salt);
    hasher.finalize().to_vec()
}

/// A fresh PIN for a new delivery, sealed to the caller (the customer) and
/// to each arbitrator.
pub(crate) fn new_pin() -> ExternResult<NewPin> {
    let bytes = random_bytes(20)?;
    let number = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) % 1_000_000;
    let secret = PinSecret { pin: format!("{number:06}"), salt: bytes[4..20].to_vec() };
    let me = agent_info()?.agent_initial_pubkey;
    Ok(NewPin {
        commitment: commit(&secret),
        sealed_pin: seal(&me, &secret)?,
        for_arbitrators: seal_to_arbitrators(&relay_governance::arbitrator_roster(), &secret)?,
    })
}

/// The caller's delivery PIN, to show the driver at the door -- `None` if
/// the order has none or isn't theirs.
#[hdk_extern]
pub fn get_my_delivery_pin(order_original_action: ActionHash) -> ExternResult<Option<String>> {
    let (_, order): (_, DeliveryOrder) = resolve_latest_decoded(order_original_action, "DeliveryOrder")?;
    let me = agent_info()?.agent_initial_pubkey;
    let Some(sealed) = order.sealed_pin.filter(|_| order.requester == me) else { return Ok(None) };
    let secret: Option<PinSecret> = open(&me, &sealed)?;
    Ok(secret.map(|s| s.pin))
}

/// The caller's handover code -- the PIN and salt their app shows as a QR
/// code for the driver to scan, which proves on its own that they handed
/// it over. `None` if the order has none or isn't theirs.
#[hdk_extern]
pub fn get_my_handover_code(order_original_action: ActionHash) -> ExternResult<Option<PinSecret>> {
    let (_, order): (_, DeliveryOrder) = resolve_latest_decoded(order_original_action, "DeliveryOrder")?;
    let me = agent_info()?.agent_initial_pubkey;
    let Some(sealed) = order.sealed_pin.filter(|_| order.requester == me) else { return Ok(None) };
    open(&me, &sealed)
}

/// Mirrors `reputation::ReputationSummary` over the zome-call boundary.
#[derive(Deserialize, Debug, Default)]
struct ReputationSummaryWire {
    dispute_resolved_against_count: u32,
}

#[derive(Serialize, Debug)]
enum ReputationTargetWire {
    Customer(AgentPubKey),
}

/// Whether a customer has lost a dispute before -- a store's
/// `PinPolicy::CustomersWithHistory` asks for their PIN.
pub(crate) fn has_dispute_history(customer: &AgentPubKey) -> ExternResult<bool> {
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "reputation", "get_reputation_summary".into(), None, ReputationTargetWire::Customer(customer.clone()))? else {
        return Ok(false);
    };
    let summary: ReputationSummaryWire = io.decode().map_err(|e| wasm_error!(e))?;
    Ok(summary.dispute_resolved_against_count > 0)
}

/// Whether a store with `policy` requires `order`'s PIN at the door.
pub(crate) fn pin_required(policy: catalog_types::PinPolicy, order: &DeliveryOrder) -> ExternResult<bool> {
    if order.pin_commitment.is_empty() {
        return Ok(false);
    }
    Ok(match policy {
        catalog_types::PinPolicy::Off => false,
        catalog_types::PinPolicy::Always => true,
        catalog_types::PinPolicy::CustomersWithHistory => has_dispute_history(&order.requester)?,
    })
}

/// What an arbitrator finds checking a delivery's PIN.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinVerdict {
    /// The order has no PIN, or the driver didn't collect it.
    NotCollected,
    /// The driver's PIN is the customer's: the customer was there.
    Matches,
    /// The driver's PIN isn't the customer's.
    Mismatch,
    /// What the customer sealed at checkout doesn't match what they
    /// committed to -- they tampered with their own PIN.
    CustomerTampered,
}

/// An arbitrator's check of the PIN collected at an order's drop-off.
pub(crate) fn verdict(order_ref: &ActionHash) -> ExternResult<PinVerdict> {
    let (_, order): (_, DeliveryOrder) = resolve_latest_decoded(order_ref.clone(), "DeliveryOrder")?;
    if order.pin_commitment.is_empty() {
        return Ok(PinVerdict::NotCollected);
    }
    let customer: Option<PinSecret> = open_my_seal(&order.pin_for_arbitrators, &order.requester)?;
    let Some(customer) = customer else { return Ok(PinVerdict::NotCollected) };
    if commit(&customer) != order.pin_commitment {
        return Ok(PinVerdict::CustomerTampered);
    }
    let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "attestation", "get_legs_for_order".into(), None, order_ref.clone())? else {
        return Ok(PinVerdict::NotCollected);
    };
    let legs: Vec<Record> = io.decode().map_err(|e| wasm_error!(e))?;
    let mut collected = false;
    for leg in legs {
        let Some(l) = relay_coordinator_support::decode_or::<Leg>(&leg) else { continue };
        if l.kind != LegKind::CustomerHandoff {
            continue;
        }
        let ZomeCallResponse::Ok(io) = call(CallTargetCell::Local, "attestation", "get_collected_pin".into(), None, leg.action_address().clone())? else { continue };
        let Some(pin): Option<String> = io.decode().map_err(|e| wasm_error!(e))? else { continue };
        if pin == customer.pin {
            return Ok(PinVerdict::Matches);
        }
        collected = true;
    }
    Ok(if collected { PinVerdict::Mismatch } else { PinVerdict::NotCollected })
}

/// The caller's (an arbitrator's) check of a delivery's PIN -- for the
/// review screen.
#[hdk_extern]
pub fn check_delivery_pin(order_original_action: ActionHash) -> ExternResult<PinVerdict> {
    if !relay_governance::is_arbitrator(&agent_info()?.agent_initial_pubkey)? {
        return Err(wasm_error!(WasmErrorInner::Guest("only an arbitrator can check a delivery's PIN".into())));
    }
    verdict(&order_original_action)
}
