//! Recording handoffs, proving them, and reading them back.
//!
//! **At the store** the driver is checked in, then handed the order:
//!
//! - *Checking in*: the driver scans the store's code at the counter (or
//!   types its six digits), which the store's own conductor checks
//!   (`check_in_at_store`) -- it then records them there
//!   (`dispatch::ensure_checked_in`). The code is how a driver shows
//!   they're at the counter; it proves nothing about the food.
//! - *Handing over*: the store scans the driver's code, or taps to confirm,
//!   recording it on its own chain (`acknowledge_leg`). Only that counts --
//!   the store says it handed the food over, so its chain says so too.
//!
//! **At the door** the customer proves it: the driver scans their code
//! (`record_leg` with `scanned`), the customer confirms in their own app
//! (`acknowledge_leg`), or the driver types the six digits the customer
//! reads out (`handoff_by_code`), which the customer's conductor checks. A
//! leave-at-door drop-off the customer chose needs none of them.

use attestation_integrity::*;
use dispatch_types::DeliveryOrder;
use hdk::prelude::*;
use handshake_coordinator_support::chain::mine;
use handshake_coordinator_support::{decode_or, guest, open, open_chunked, original_action_of, resolve_latest, resolve_latest_decoded, seal_chunked, written};
use handshake_types::GeoPoint;

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
    if let Some(problem) = handshake_integrity_support::image_problem(&input.photo_data_uri) {
        return Err(guest(problem));
    }
    if let Some(scanned) = &input.scanned {
        if input.kind == LegKind::MerchantHandoff {
            return Err(guest("The store hands the order over by scanning your code."));
        }
        if !pin_matches(Some(scanned), &order_now.pin_commitment) {
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
    written(action_hash)
}

/// The other party to a handoff confirming it -- signed on their own chain.
/// Safe to repeat: a handoff already confirmed returns the existing receipt.
#[hdk_extern]
pub fn acknowledge_leg(leg_action: ActionHash) -> ExternResult<Record> {
    let me = agent_info()?.agent_initial_pubkey;
    let leg_record = resolve_latest(leg_action.clone())?;
    let leg: Leg = leg_record.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("that isn't a handoff"))?;
    if leg.to != me {
        return Err(guest("Only the other party to a handoff can confirm it."));
    }
    if let Some(existing) = my_receipt_for(&leg_action)? {
        return Ok(existing);
    }
    // The store handing an order over checks its driver in first, if it
    // hasn't -- in this same commit, so the two stand or fall together.
    if leg.kind == LegKind::MerchantHandoff {
        let order = original_action_of(leg.order_ref.clone())?;
        let (_, current): (_, DeliveryOrder) = resolve_latest_decoded(order.clone(), "DeliveryOrder")?;
        let driver = match &current.accepted_bid {
            Some(bid) => resolve_latest(bid.clone())?.entry().to_app_option::<dispatch_types::Bid>().map_err(|e| wasm_error!(e))?.map(|b| b.bidder),
            None => None,
        };
        if driver.as_ref() != Some(&leg.from) {
            return Err(guest("That driver isn't collecting this order now."));
        }
        dispatch::<ActionHash>("ensure_checked_in", order.clone())?;
    }
    let is_pickup = leg.kind == LegKind::MerchantHandoff;
    let receipt = ReceiptAttestation { leg: leg_action.clone(), attested_at: sys_time()? };
    let action_hash = create_entry(&EntryTypes::ReceiptAttestation(receipt))?;
    create_link(leg_action, action_hash.clone(), LinkTypes::LegToReceipt, ())?;
    // The driver's app picks the order up on it.
    if is_pickup {
        let _ = dispatch::<()>("notify_handed_over", original_action_of(leg.order_ref)?);
    }
    written(action_hash)
}

/// Calls the dispatch zome on this cell.
fn dispatch<O: serde::de::DeserializeOwned + std::fmt::Debug>(function: &str, input: impl Serialize + std::fmt::Debug) -> ExternResult<O> {
    match call(CallTargetCell::Local, "dispatch", function.into(), None, input)? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e)),
        ZomeCallResponse::NetworkError(message) => Err(guest(&message)),
        other => Err(guest(format!("{other:?}"))),
    }
}

// --- checking in at the store ---

#[derive(Serialize, Deserialize, Debug)]
pub struct CheckInInput {
    /// The order (any version of it).
    pub order_ref: ActionHash,
    /// The store's code: its six digits, scanned or read out.
    pub code: String,
}

/// The driver checking in at the store, with its code: asks the store's own
/// conductor to check it, which checks them in if it's right. Needs the
/// store's app online -- they're at its counter.
#[hdk_extern]
pub fn check_in_at_store(input: CheckInInput) -> ExternResult<()> {
    let (_, order): (_, DeliveryOrder) = resolve_latest_decoded(input.order_ref.clone(), "DeliveryOrder")?;
    let check: CodeCheck = match call_remote(order.merchant, zome_info()?.name, "confirm_check_in".into(), None, input)? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e))?,
        _ => return Err(guest("The store's app isn't reachable. Ask them to open it, then try again.")),
    };
    match check {
        // The store dates the check-in, and its wait runs from then: one
        // dated well off this driver's own clock is refused here, so they
        // know to report it.
        CodeCheck::Confirmed(checked_in) => match get(checked_in, GetOptions::network())? {
            Some(record) if (record.action().timestamp().as_micros() - sys_time()?.as_micros()).unsigned_abs() > handshake_governance::clock_tolerance().as_micros() as u64 => {
                Err(guest("The store's app dated your check-in well off the time. If it keeps you waiting, report it."))
            }
            _ => Ok(()),
        },
        CodeCheck::Wrong { tries_left: 1 } => Err(guest("That code isn't right. One try left.")),
        CodeCheck::Wrong { tries_left } => Err(guest(format!("That code isn't right. {tries_left} tries left."))),
        CodeCheck::Locked => Err(guest("Too many wrong codes. Ask the store to hand the order over by scanning your code.")),
        CodeCheck::Refused(reason) => Err(guest(&reason)),
    }
}

/// The store's side of `check_in_at_store`, on its own conductor: checks
/// the code against its own sealed copy, for the order's own driver only,
/// and checks them in if it's right. Wrong codes count toward the same
/// limit as any other for the order.
#[hdk_extern]
pub fn confirm_check_in(input: CheckInInput) -> ExternResult<CodeCheck> {
    let me = agent_info()?.agent_initial_pubkey;
    let order = original_action_of(input.order_ref.clone())?;
    let (_, current): (_, DeliveryOrder) = resolve_latest_decoded(order.clone(), "DeliveryOrder")?;
    if current.merchant != me {
        return Ok(CodeCheck::Refused("That order isn't from this store.".into()));
    }
    let driver = match &current.accepted_bid {
        Some(bid) => resolve_latest(bid.clone())?.entry().to_app_option::<dispatch_types::Bid>().map_err(|e| wasm_error!(e))?.map(|b| b.bidder),
        None => None,
    };
    if driver != Some(call_info()?.provenance) {
        return Ok(CodeCheck::Refused("Only the order's driver checks in for it.".into()));
    }
    let max_attempts = handshake_governance::max_code_attempts();
    let wrong = wrong_attempts(&order)?;
    if wrong >= max_attempts {
        return Ok(CodeCheck::Locked);
    }
    let sealed = current.sealed_pickup_code.ok_or(guest("This order has no check-in code yet."))?;
    let secret: PinSecret = open(&me, &sealed)?.ok_or(guest("Couldn't open your code on this device."))?;
    if input.code.trim() != secret.pin {
        create_entry(&EntryTypes::CodeAttempt(CodeAttempt { order }))?;
        let tries_left = max_attempts - wrong - 1;
        return Ok(if tries_left == 0 { CodeCheck::Locked } else { CodeCheck::Wrong { tries_left } });
    }
    match dispatch::<ActionHash>("ensure_checked_in", order) {
        Ok(checked_in) => Ok(CodeCheck::Confirmed(checked_in)),
        // The order hasn't reached the store's app as it is now, say.
        Err(_) => Ok(CodeCheck::Refused("The store's app couldn't check you in yet. Try again in a moment.".into())),
    }
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
    /// It won't check this at all -- and why: the caller isn't the order's
    /// driver, say, or the order isn't waiting on one.
    Refused(String),
}

/// The driver proving a handoff with the six digits the giver read out:
/// asks the giver's own conductor to check them, which confirms the handoff
/// (`ReceiptAttestation`) if they're right. Needs the giver's app online --
/// they're standing there with it.
#[hdk_extern]
pub fn handoff_by_code(input: HandoffCodeInput) -> ExternResult<ActionHash> {
    let leg: Leg = resolve_latest(input.leg.clone())?.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("that isn't a handoff"))?;
    if leg.from != agent_info()?.agent_initial_pubkey {
        return Err(guest("Only the driver who made a handoff can prove it."));
    }
    if leg.kind == LegKind::MerchantHandoff {
        return Err(guest("The store hands the order over by scanning your code, or confirming in its app."));
    }
    let check: CodeCheck = match call_remote(leg.to, zome_info()?.name, "confirm_by_code".into(), None, input)? {
        ZomeCallResponse::Ok(io) => io.decode().map_err(|e| wasm_error!(e))?,
        _ => return Err(guest("Their app isn't reachable. Ask them to open it, or scan their code instead.")),
    };
    match check {
        CodeCheck::Confirmed(receipt) => Ok(receipt),
        CodeCheck::Wrong { tries_left: 1 } => Err(guest("That code isn't right. One try left.")),
        CodeCheck::Wrong { tries_left } => Err(guest(format!("That code isn't right. {tries_left} tries left."))),
        CodeCheck::Locked => Err(guest("Too many wrong codes. Scan their code, or ask them to confirm in their app.")),
        CodeCheck::Refused(reason) => Err(guest(&reason)),
    }
}

/// The giver's side of `handoff_by_code`, on their own conductor: checks
/// the code against their own sealed copy and, if it's right, confirms the
/// handoff. Wrong codes are counted privately; after a few, it stops
/// answering for that order. Anyone can call it (handoffs are public), so it
/// answers only the handoff's own driver -- a stranger can't spend the
/// giver's tries and lock them out.
#[hdk_extern]
pub fn confirm_by_code(input: HandoffCodeInput) -> ExternResult<CodeCheck> {
    let me = agent_info()?.agent_initial_pubkey;
    let leg: Leg = resolve_latest(input.leg.clone())?.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("that isn't a handoff"))?;
    if leg.to != me {
        return Err(guest("That handoff isn't to you."));
    }
    if call_info()?.provenance != leg.from {
        return Err(guest("Only the driver making a handoff can check its code."));
    }
    let order = original_action_of(leg.order_ref.clone())?;
    // A handful of tries can't find six digits; a million could.
    let max_attempts = handshake_governance::max_code_attempts();
    let wrong = wrong_attempts(&order)?;
    if wrong >= max_attempts {
        return Ok(CodeCheck::Locked);
    }
    let (_, current): (_, DeliveryOrder) = resolve_latest_decoded(order.clone(), "DeliveryOrder")?;
    // At the store, the code checks a driver in (`confirm_check_in`); it
    // never proves a pickup.
    if leg.kind == LegKind::MerchantHandoff {
        return Err(guest("A pickup is confirmed by the store, not with a code."));
    }
    let sealed = current.sealed_pin;
    let secret: PinSecret = open(&me, &sealed)?.ok_or(guest("Couldn't open your code on this device."))?;
    if input.code.trim() != secret.pin {
        create_entry(&EntryTypes::CodeAttempt(CodeAttempt { order }))?;
        let tries_left = max_attempts - wrong - 1;
        return Ok(if tries_left == 0 { CodeCheck::Locked } else { CodeCheck::Wrong { tries_left } });
    }
    Ok(CodeCheck::Confirmed(acknowledge_leg(input.leg)?.action_address().clone()))
}

/// Wrong codes typed in for `order`, from the caller's own chain -- read
/// back to when the order was placed (on its customer's clock, so less the
/// network's tolerance for clocks: none can come before it).
fn wrong_attempts(order: &ActionHash) -> ExternResult<u32> {
    let placed = get(order.clone(), GetOptions::default())?.ok_or(guest("order not found"))?.action().timestamp();
    let since = Timestamp::from_micros(placed.as_micros() - handshake_governance::clock_tolerance().as_micros() as i64);
    let attempts = mine(&[EntryType::try_from(UnitEntryTypes::CodeAttempt)?]).since(since).records()?;
    Ok(attempts.iter().filter(|r| decode_or::<CodeAttempt>(r).is_some_and(|a| &a.order == order)).count() as u32)
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
    Ok(evidence.filter(|e| handshake_integrity_support::image_problem(&e.photo_data_uri).is_none()))
}

/// The caller's own receipt for `leg`: their receipts are linked from it.
fn my_receipt_for(leg: &ActionHash) -> ExternResult<Option<Record>> {
    let query = LinkQuery::try_new(leg.clone(), LinkTypes::LegToReceipt)?.author(agent_info()?.agent_initial_pubkey);
    for link in get_links(query, GetStrategy::Local)? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        if let Some(record) = get(hash, GetOptions::local())?.filter(|r| decode_or::<ReceiptAttestation>(r).is_some_and(|receipt| &receipt.leg == leg)) {
            return Ok(Some(record));
        }
    }
    Ok(None)
}

/// The confirmation of a handoff, if it has one -- only ever from the
/// handoff's other party.
#[hdk_extern]
pub fn get_receipt_for_leg(leg: ActionHash) -> ExternResult<Option<Record>> {
    let Some(leg_record) = get(leg.clone(), GetOptions::default())? else { return Ok(None) };
    let Some(to) = leg_record.entry().to_app_option::<Leg>().ok().flatten().map(|l| l.to) else { return Ok(None) };
    for link in get_links(LinkQuery::try_new(leg, LinkTypes::LegToReceipt)?.author(to.clone()), GetStrategy::default())? {
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

/// Proof the store handed the order to the caller -- its record of handing
/// over their pickup leg, what `DeliveryOrder::pickup_proof` cites.
#[hdk_extern]
pub fn pickup_proof_for_order(order_ref: ActionHash) -> ExternResult<Option<ActionHash>> {
    let me = agent_info()?.agent_initial_pubkey;
    for record in get_legs_for_order(order_ref)? {
        let Some(leg) = record.entry().to_app_option::<Leg>().ok().flatten() else { continue };
        if leg.kind != LegKind::MerchantHandoff || leg.from != me {
            continue;
        }
        if let Some(receipt) = get_receipt_for_leg(record.action_address().clone())? {
            return Ok(Some(receipt.action_address().clone()));
        }
    }
    Ok(None)
}

/// Proof the order reached its customer -- what
/// `DeliveryOrder::delivery_receipts` carries.
#[hdk_extern]
pub fn delivery_proof_for_order(order_ref: ActionHash) -> ExternResult<Option<ActionHash>> {
    handoff_proof(order_ref, LegKind::CustomerHandoff)
}

