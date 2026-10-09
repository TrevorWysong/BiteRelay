//! Recording handoffs, acknowledging them, and reading them back --
//! including `delivery_proof_for_order`, which `dispatch::complete_delivery`
//! depends on.

use attestation_integrity::*;
use hdk::prelude::*;
use relay_coordinator_support::{open, open_my_seal, original_action_of, resolve_latest, seal, seal_to_arbitrators};
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
    /// A photo at the door, inline; empty for none.
    #[serde(default)]
    pub photo_data_uri: String,
    /// The PIN the customer gave at the door, if the driver asked -- which
    /// they must when the order's store requires it. Sealed to the
    /// arbitrators; nobody else ever sees it.
    #[serde(default)]
    pub pin: Option<String>,
    /// The PIN and salt from the customer's handover code, if the driver
    /// scanned it -- the customer's receipt, checked by validation.
    #[serde(default)]
    pub scanned: Option<PinSecret>,
}

/// The driver recording a handoff as it happens. The other party
/// acknowledges it with `acknowledge_leg` whenever they can -- the store
/// with a tap on its queue, the customer as they confirm they've received
/// their order. Until then it stands as the driver's own claim.
#[hdk_extern]
pub fn record_leg(input: RecordLegInput) -> ExternResult<Record> {
    let from = agent_info()?.agent_initial_pubkey;
    let order = original_action_of(input.order_ref)?;
    // Recorded against the order as it stands -- the version that names
    // this driver, which validation checks.
    let current = resolve_latest(order.clone())?;
    if let Some(problem) = relay_integrity_support::image_problem(&input.photo_data_uri) {
        return Err(guest(problem));
    }
    let evidence = HandoffEvidence { geo: input.geo_at_completion, photo_data_uri: input.photo_data_uri };
    let sealed_evidence = seal(&input.to, &evidence)?;
    let pin = input.pin.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if pin.as_ref().is_some_and(|p| p.len() != 6 || !p.bytes().all(|b| b.is_ascii_digit())) {
        return Err(guest("a delivery PIN is 6 digits"));
    }
    if let Some(scanned) = &input.scanned {
        let order_record: dispatch_types::DeliveryOrder = current.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("that isn't a delivery"))?;
        if !pin_matches(Some(scanned), &order_record.pin_commitment) {
            return Err(guest("That code isn't for this order."));
        }
    }
    let sealed_pin_for_arbitrators = match &pin {
        Some(pin) => seal_to_arbitrators(&relay_governance::arbitrator_roster(), pin)?,
        None => Vec::new(),
    };
    let leg = Leg {
        order_ref: current.action_address().clone(),
        sequence: input.sequence,
        kind: input.kind,
        from,
        to: input.to,
        completed_at: sys_time()?,
        sealed_evidence,
        sealed_pin_for_arbitrators,
        revealed_pin: input.scanned,
    };
    let is_dropoff = leg.kind == LegKind::CustomerHandoff;
    let action_hash = create_entry(&EntryTypes::Leg(leg))?;
    create_link(order.clone(), action_hash.clone(), LinkTypes::OrderToLeg, ())?;
    // The customer hears at once: confirm it, or report a problem, within
    // the network's window.
    if is_dropoff {
        let _ = call(CallTargetCell::Local, "dispatch", "notify_handoff".into(), None, order);
    }
    get(action_hash, GetOptions::local())?.ok_or(guest("could not read back leg"))
}

/// The other party to a handoff acknowledging it -- signed on their own
/// chain, so a completed delivery carries proof from both sides. Safe to
/// repeat: a handoff already acknowledged returns the existing receipt.
#[hdk_extern]
pub fn acknowledge_leg(leg_action: ActionHash) -> ExternResult<Record> {
    let me = agent_info()?.agent_initial_pubkey;
    let leg_record = resolve_latest(leg_action.clone())?;
    let leg: Leg = leg_record.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("that isn't a handoff"))?;
    if leg.to != me {
        return Err(guest("only the other party to a handoff can acknowledge it"));
    }
    if let Some(existing) = my_receipt_for(&leg_action)? {
        return Ok(existing);
    }
    let receipt = ReceiptAttestation { leg: leg_action.clone(), attested_at: sys_time()? };
    let action_hash = create_entry(&EntryTypes::ReceiptAttestation(receipt))?;
    create_link(leg_action, action_hash.clone(), LinkTypes::LegToReceipt, ())?;
    get(action_hash, GetOptions::local())?.ok_or(guest("could not read back receipt"))
}

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
    let evidence: Option<HandoffEvidence> = open(&counterpart, &leg.sealed_evidence)?;
    // Checked again on the way out: a modified client could seal anything.
    Ok(evidence.filter(|e| relay_integrity_support::image_problem(&e.photo_data_uri).is_none()))
}

/// One of a handoff's two parties sharing its evidence with the
/// arbitrators, for a dispute. Safe to repeat.
#[hdk_extern]
pub fn share_handoff_evidence(leg_action: ActionHash) -> ExternResult<ActionHash> {
    let me = agent_info()?.agent_initial_pubkey;
    for link in get_links(LinkQuery::try_new(leg_action.clone(), LinkTypes::LegToEvidenceShare)?, GetStrategy::default())? {
        if link.author == me {
            if let Some(hash) = link.target.into_action_hash() {
                return Ok(hash);
            }
        }
    }
    let evidence = get_handoff_evidence(leg_action.clone())?.ok_or(guest("only a handoff's two parties can share its evidence"))?;
    let seals = seal_to_arbitrators(&relay_governance::arbitrator_roster(), &evidence)?;
    let hash = create_entry(&EntryTypes::EvidenceShare(EvidenceShare { leg: leg_action.clone(), seals }))?;
    create_link(leg_action, hash.clone(), LinkTypes::LegToEvidenceShare, ())?;
    Ok(hash)
}

/// A handoff's evidence as shared with the caller, an arbitrator -- by
/// either party; the first that opens.
#[hdk_extern]
pub fn get_shared_evidence(leg_action: ActionHash) -> ExternResult<Option<HandoffEvidence>> {
    for link in get_links(LinkQuery::try_new(leg_action, LinkTypes::LegToEvidenceShare)?, GetStrategy::default())? {
        let Some(hash) = link.target.into_action_hash() else { continue };
        let Some(record) = get(hash, GetOptions::default())? else { continue };
        let Ok(Some(share)) = record.entry().to_app_option::<EvidenceShare>() else { continue };
        let opened: Option<HandoffEvidence> = open_my_seal(&share.seals, record.action().author())?;
        if let Some(evidence) = opened.filter(|e| relay_integrity_support::image_problem(&e.photo_data_uri).is_none()) {
            return Ok(Some(evidence));
        }
    }
    Ok(None)
}

/// The PIN the driver collected at a drop-off, for the caller, an
/// arbitrator -- `None` if none was collected (or the caller isn't one).
#[hdk_extern]
pub fn get_collected_pin(leg_action: ActionHash) -> ExternResult<Option<String>> {
    let record = get(leg_action, GetOptions::default())?.ok_or(guest("handoff not found"))?;
    let leg: Leg = record.entry().to_app_option().map_err(|e| wasm_error!(e))?.ok_or(guest("that isn't a handoff"))?;
    open_my_seal(&leg.sealed_pin_for_arbitrators, &leg.from)
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

/// The acknowledgment of a handoff, if it has one.
#[hdk_extern]
pub fn get_receipt_for_leg(leg: ActionHash) -> ExternResult<Option<Record>> {
    let links = get_links(LinkQuery::try_new(leg, LinkTypes::LegToReceipt)?, GetStrategy::default())?;
    let Some(link) = links.into_iter().next() else { return Ok(None) };
    let Some(action_hash) = link.target.into_action_hash() else { return Ok(None) };
    get(action_hash, GetOptions::default())
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

/// What a delivery needs to complete: the driver's record of collecting it
/// from the store, and the customer's acknowledgment that it reached them
/// -- returned as the two references `DeliveryOrder::delivery_receipts`
/// carries (which `dispatch_integrity` checks), or an error saying what's
/// missing.
#[hdk_extern]
pub fn delivery_proof_for_order(order_ref: ActionHash) -> ExternResult<Vec<ActionHash>> {
    let legs = get_legs_for_order(order_ref)?;
    let of_kind = |kind: LegKind| legs.iter().filter(move |r| r.entry().to_app_option::<Leg>().ok().flatten().is_some_and(|leg| leg.kind == kind));
    let pickup = of_kind(LegKind::MerchantHandoff).next().ok_or(guest("the driver hasn't recorded collecting this order from the store"))?;
    let mut customer_receipt = None;
    for handoff in of_kind(LegKind::CustomerHandoff) {
        // A drop-off against the customer's scanned code is their receipt.
        if handoff.entry().to_app_option::<Leg>().ok().flatten().is_some_and(|leg| leg.revealed_pin.is_some()) {
            customer_receipt = Some(handoff.action_address().clone());
            break;
        }
        if let Some(receipt) = get_receipt_for_leg(handoff.action_address().clone())? {
            customer_receipt = Some(receipt.action_address().clone());
            break;
        }
    }
    let customer_receipt = customer_receipt.ok_or(guest("the customer hasn't acknowledged receiving this order"))?;
    Ok(vec![pickup.action_address().clone(), customer_receipt])
}

fn guest(message: &str) -> WasmError {
    wasm_error!(WasmErrorInner::Guest(message.into()))
}
