//! Recording handoffs, proving them, and reading them back.
//!
//! A handoff is proved by its giver -- the store at pickup, the customer at
//! the door -- in one of three ways: the driver scans the giver's code (a
//! QR code; `record_leg` with `scanned`), the giver taps to confirm it in
//! their own app (`acknowledge_leg`), or the driver types in the six digits
//! the giver reads out (`handoff_by_code`), which the giver's own conductor
//! checks. A leave-at-door drop-off the customer chose needs none of them.

use attestation_integrity::*;
use dispatch_types::DeliveryOrder;
use hdk::prelude::*;
use relay_coordinator_support::{open, open_chunked, original_action_of, resolve_latest, resolve_latest_decoded, seal_chunked};
use relay_types::GeoPoint;

#[derive(Serialize, Deserialize, Debug)]
pub struct RecordLegInput {
    /// The order (its original action, or any version of it).
    pub order_ref: ActionHash,
    pub sequence: u8,
    pub kind: LegKind,
    /// The store (picking up) or the customer (handing over).
    pub to: AgentPubKey,
    /// Where it happened -- sealed to the other party with the photo (see
    /// `Leg::sealed_evidence`), never published.
    pub geo_at_completion: GeoPoint,
    /// A photo, inline; empty for none.
    #[serde(default)]
    pub photo_data_uri: String,
    /// The giver's code, if the driver scanned it -- proof on its own,
    /// checked by validation.
    #[serde(default)]
    pub scanned: Option<PinSecret>,
    /// Left at the door, on an order whose customer chose that.
    #[serde(default)]
    pub left_at_door: bool,
}

/// The driver recording a handoff as it happens.
#[hdk_extern]
pub fn record_leg(input: RecordLegInput) -> ExternResult<Record> {
    let from = agent_info()?.agent_initial_pubkey;
    let order = original_action_of(input.order_ref)?;
    // Recorded against the order as it stands -- the version that names
    // this driver, which validation checks.
    let (current, order_now): (_, DeliveryOrder) = resolve_latest_decoded(order.clone(), "DeliveryOrder")?;
    if let Some(problem) = relay_integrity_support::image_problem(&input.photo_data_uri) {
        return Err(guest(problem));
    }
    if let Some(scanned) = &input.scanned {
        let commitment = match input.kind {
            LegKind::MerchantHandoff => &order_now.pickup_commitment,
            LegKind::CustomerHandoff => &order_now.pin_commitment,
        };
        if !pin_matches(Some(scanned), commitment) {
            return Err(guest("That code isn't for this order."));
        }
    }
    if input.left_at_door && input.photo_data_uri.is_empty() {
        return Err(guest("Take a photo of where you left it: it's the customer's proof of delivery."));
    }
    let evidence = HandoffEvidence { geo: input.geo_at_completion, photo_data_uri: input.photo_data_uri };
    let leg = Leg {
        order_ref: current.action_address().clone(),
        sequence: input.sequence,
        kind: input.kind,
        from,
        sealed_evidence: seal_chunked(&input.to, &evidence)?,
        to: input.to,
        completed_at: sys_time()?,
        revealed_pin: input.scanned,
        left_at_door: input.left_at_door,
    };
    let is_dropoff = leg.kind == LegKind::CustomerHandoff;
    let action_hash = create_entry(&EntryTypes::Leg(leg))?;
    create_link(order.clone(), action_hash.clone(), LinkTypes::OrderToLeg, ())?;
    // The customer hears at once.
    if is_dropoff {
        let _ = call(CallTargetCell::Local, "dispatch", "notify_handoff".into(), None, order);
    }
    get(action_hash, GetOptions::local())?.ok_or(guest("could not read back leg"))
}

/// The other party to a handoff confirming it -- signed on their own chain.
/// Safe to repeat: a handoff already confirmed returns the existing receipt.
#[hdk_extern]
pub fn acknowledge_leg(leg_action: ActionHash) -> ExternResult<Record> {
    let me = agent_info()?.agent_initial_pubkey;
    let leg_record = resolve_latest(leg_action.clone())?;
    let leg: Leg = leg_record.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("that isn't a handoff"))?;
    if leg.to != me {
        return Err(guest("only the other party to a handoff can confirm it"));
    }
    if let Some(existing) = my_receipt_for(&leg_action)? {
        return Ok(existing);
    }
    let receipt = ReceiptAttestation { leg: leg_action.clone(), attested_at: sys_time()? };
    let action_hash = create_entry(&EntryTypes::ReceiptAttestation(receipt))?;
    create_link(leg_action, action_hash.clone(), LinkTypes::LegToReceipt, ())?;
    get(action_hash, GetOptions::local())?.ok_or(guest("could not read back receipt"))
}

// --- typed codes ---

#[derive(Serialize, Deserialize, Debug)]
pub struct HandoffCodeInput {
    /// The driver's handoff leg.
    pub leg: ActionHash,
    /// The six digits the giver read out.
    pub code: String,
}

/// What the giver's conductor says about a typed code.
#[derive(Serialize, Deserialize, Debug)]
pub enum CodeCheck {
    /// Right: the handoff is confirmed, by this receipt.
    Confirmed(ActionHash),
    /// Wrong, with how many tries are left for this order.
    Wrong { tries_left: u32 },
    /// Too many wrong codes for this order: it stops answering.
    Locked,
}

/// The driver proving a handoff with the six digits the giver read out:
/// asks the giver's own conductor to check them, which confirms the handoff
/// (`ReceiptAttestation`) if they're right. Needs the giver's app online --
/// they're standing there with it.
#[hdk_extern]
pub fn handoff_by_code(input: HandoffCodeInput) -> ExternResult<ActionHash> {
    let leg: Leg = resolve_latest(input.leg.clone())?.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("that isn't a handoff"))?;
    if leg.from != agent_info()?.agent_initial_pubkey {
        return Err(guest("only the driver who made a handoff proves it"));
    }
    let check: CodeCheck = match call_remote(leg.to, zome_info()?.name, "confirm_by_code".into(), None, input)? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e))?,
        _ => return Err(guest("Their app isn't reachable. Ask them to open it, or scan their code instead.")),
    };
    match check {
        CodeCheck::Confirmed(receipt) => Ok(receipt),
        CodeCheck::Wrong { tries_left: 1 } => Err(guest("That code isn't right. One try left.")),
        CodeCheck::Wrong { tries_left } => Err(guest(&format!("That code isn't right. {tries_left} tries left."))),
        CodeCheck::Locked => Err(guest("Too many wrong codes. Scan their code, or ask them to confirm in their app.")),
    }
}

/// The giver's side of `handoff_by_code`, on their own conductor: checks
/// the code against their own sealed copy and, if it's right, confirms the
/// handoff. Wrong codes are counted privately; after a few, it stops
/// answering for that order.
#[hdk_extern]
pub fn confirm_by_code(input: HandoffCodeInput) -> ExternResult<CodeCheck> {
    let me = agent_info()?.agent_initial_pubkey;
    let leg: Leg = resolve_latest(input.leg.clone())?.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("that isn't a handoff"))?;
    if leg.to != me {
        return Err(guest("that handoff isn't to you"));
    }
    let order = original_action_of(leg.order_ref.clone())?;
    // A handful of tries can't find six digits; a million could.
    let max_attempts = relay_governance::max_code_attempts();
    let wrong = wrong_attempts(&order)?;
    if wrong >= max_attempts {
        return Ok(CodeCheck::Locked);
    }
    let (_, current): (_, DeliveryOrder) = resolve_latest_decoded(order.clone(), "DeliveryOrder")?;
    let sealed = match leg.kind {
        LegKind::MerchantHandoff => current.sealed_pickup_code.ok_or(guest("this order has no pickup code yet"))?,
        LegKind::CustomerHandoff => current.sealed_pin,
    };
    let secret: PinSecret = open(&me, &sealed)?.ok_or(guest("couldn't open your code"))?;
    if input.code.trim() != secret.pin {
        create_entry(&EntryTypes::CodeAttempt(CodeAttempt { order }))?;
        let tries_left = max_attempts - wrong - 1;
        return Ok(if tries_left == 0 { CodeCheck::Locked } else { CodeCheck::Wrong { tries_left } });
    }
    Ok(CodeCheck::Confirmed(acknowledge_leg(input.leg)?.action_address().clone()))
}

/// Wrong codes typed in for `order`, from the caller's own chain.
fn wrong_attempts(order: &ActionHash) -> ExternResult<u32> {
    let attempts = query(ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::CodeAttempt)?).include_entries(true))?;
    Ok(attempts.iter().filter(|r| r.entry().to_app_option::<CodeAttempt>().ok().flatten().is_some_and(|a| &a.order == order)).count() as u32)
}

// --- reading ---

/// A handoff's evidence -- where it happened, and any photo -- for either
/// of its two parties; `None` for anyone else.
#[hdk_extern]
pub fn get_handoff_evidence(leg_action: ActionHash) -> ExternResult<Option<HandoffEvidence>> {
    let me = agent_info()?.agent_initial_pubkey;
    let record = get(leg_action, GetOptions::default())?.ok_or(guest("handoff not found"))?;
    let leg: Leg = record.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("that isn't a handoff"))?;
    let counterpart = if me == leg.from {
        leg.to
    } else if me == leg.to {
        leg.from
    } else {
        return Ok(None);
    };
    let evidence: Option<HandoffEvidence> = open_chunked(&counterpart, &leg.sealed_evidence)?;
    // Checked again on the way out: a modified client could seal anything.
    Ok(evidence.filter(|e| relay_integrity_support::image_problem(&e.photo_data_uri).is_none()))
}

/// The caller's own receipt for `leg`, from their chain.
fn my_receipt_for(leg: &ActionHash) -> ExternResult<Option<Record>> {
    Ok(list_my_receipts(())?
        .into_iter()
        .find(|record| record.entry().to_app_option::<ReceiptAttestation>().ok().flatten().is_some_and(|r| &r.leg == leg)))
}

/// Every receipt the caller has signed, from their own chain.
#[hdk_extern]
pub fn list_my_receipts(_: ()) -> ExternResult<Vec<Record>> {
    query(ChainQueryFilter::new().entry_type(EntryType::try_from(UnitEntryTypes::ReceiptAttestation)?).include_entries(true))
}

/// The confirmation of a handoff, if it has one -- only ever from the
/// handoff's other party.
#[hdk_extern]
pub fn get_receipt_for_leg(leg: ActionHash) -> ExternResult<Option<Record>> {
    let Some(leg_record) = get(leg.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(to) = leg_record.entry().to_app_option::<Leg>().ok().flatten().map(|l| l.to) else { return Ok(None) };
    for link in get_links(LinkQuery::try_new(leg, LinkTypes::LegToReceipt)?, GetStrategy::default())? {
        if link.author != to {
            continue;
        }
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if let Some(record) = get(action_hash, GetOptions::default())? {
            return Ok(Some(record));
        }
    }
    Ok(None)
}

/// Every handoff recorded on an order.
#[hdk_extern]
pub fn get_legs_for_order(order_ref: ActionHash) -> ExternResult<Vec<Record>> {
    let order = original_action_of(order_ref)?;
    let links = get_links(LinkQuery::try_new(order, LinkTypes::OrderToLeg)?, GetStrategy::default())?;
    let mut legs = Vec::with_capacity(links.len());
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if let Some(record) = get(action_hash, GetOptions::default())? {
            legs.push(record);
        }
    }
    Ok(legs)
}

/// Proof of an order's handoff of `kind`: a leg that carries it on its own
/// (the giver's scanned code; a drop-off left at the door) or the giver's
/// confirmation of a leg -- `None` if there's none yet.
fn handoff_proof(order_ref: ActionHash, kind: LegKind) -> ExternResult<Option<ActionHash>> {
    let legs: Vec<(Record, Leg)> = get_legs_for_order(order_ref)?
        .into_iter()
        .filter_map(|r| r.entry().to_app_option::<Leg>().ok().flatten().map(|l| (r, l)))
        .filter(|(_, l)| l.kind == kind)
        .collect();
    if let Some((record, _)) = legs.iter().find(|(_, l)| l.revealed_pin.is_some() || l.left_at_door) {
        return Ok(Some(record.action_address().clone()));
    }
    for (record, _) in &legs {
        if let Some(receipt) = get_receipt_for_leg(record.action_address().clone())? {
            return Ok(Some(receipt.action_address().clone()));
        }
    }
    Ok(None)
}

/// Proof the store handed the order to the driver -- what
/// `DeliveryOrder::pickup_proof` cites.
#[hdk_extern]
pub fn pickup_proof_for_order(order_ref: ActionHash) -> ExternResult<Option<ActionHash>> {
    handoff_proof(order_ref, LegKind::MerchantHandoff)
}

/// Proof the order reached its customer -- what
/// `DeliveryOrder::delivery_receipts` carries.
#[hdk_extern]
pub fn delivery_proof_for_order(order_ref: ActionHash) -> ExternResult<Option<ActionHash>> {
    handoff_proof(order_ref, LegKind::CustomerHandoff)
}

fn guest(message: &str) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message.into()))
}
