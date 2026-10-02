//! The plain (non-countersigned) side of attestation: recording a leg,
//! linking a leg to its receipt once countersigning completes (see
//! `countersigning.rs`), and every read-side query, including the one
//! `dispatch` actually depends on (`count_attested_legs_for_order`).

use crate::countersigning::entry_def_parts;
use attestation_integrity::*;
use hdk::prelude::*;
use relay_types::GeoPoint;

#[derive(Serialize, Deserialize, Debug)]
pub struct RecordLegInput {
    pub order_ref: ActionHash,
    pub sequence: u8,
    pub kind: LegKind,
    pub to: AgentPubKey,
    pub geo_at_completion: GeoPoint,
    /// See `Leg.photo_data_uri`'s own doc comment -- optional, empty string
    /// means no photo.
    #[serde(default)]
    pub photo_data_uri: String,
}

/// Either party on a leg (the one initiating a handoff) records the raw
/// event unilaterally. The dual-signed *proof* that both parties agree it
/// happened comes next, via `countersigning::initiate_leg_attestation` --
/// see the integrity crate's doc comment on why these are two separate
/// entries.
#[hdk_extern]
pub fn record_leg(input: RecordLegInput) -> ExternResult<Record> {
    let from = agent_info()?.agent_initial_pubkey;
    let leg = Leg {
        order_ref: input.order_ref.clone(),
        sequence: input.sequence,
        kind: input.kind,
        from,
        to: input.to,
        geo_at_completion: input.geo_at_completion,
        completed_at: sys_time()?,
        photo_data_uri: input.photo_data_uri,
    };
    let action_hash = create_entry(&EntryTypes::Leg(leg))?;
    create_link(input.order_ref, action_hash.clone(), LinkTypes::OrderToLeg, ())?;
    get(action_hash, GetOptions::local())?
        .ok_or(wasm_error!(WasmErrorInner::Guest("could not read back leg".into())))
}

/// A genuinely separate zome call from `initiate_leg_attestation` -- not
/// just a separate function. Holochain requires a countersigning write to
/// be the *only* action flushed from that call; bundling this link creation
/// into the same call (even via a helper function) still flushes together
/// and trips `DirtyCounterSigningWrite`/the equivalent chain-error. One
/// party linking once is enough for DHT-wide discoverability via `get_links`.
#[hdk_extern]
pub fn link_leg_to_receipt(input: LinkLegToReceiptInput) -> ExternResult<()> {
    create_link(input.leg, input.receipt, LinkTypes::LegToReceipt, ())?;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LinkLegToReceiptInput {
    pub leg: ActionHash,
    pub receipt: ActionHash,
}

/// Queries the caller's own source chain directly for every
/// ReceiptAttestation they've committed -- entirely local, no DHT/link
/// lookup involved. This is the authoritative check that a countersigning
/// party actually has the entry on their own chain; `get_receipt_for_leg`'s
/// link-based lookup is only a convenience index on top and is subject to
/// DHT integration timing that this bypasses entirely.
#[hdk_extern]
pub fn list_my_receipts(_: ()) -> ExternResult<Vec<Record>> {
    let dummy = EntryTypes::ReceiptAttestation(ReceiptAttestation {
        leg: ActionHash::from_raw_36(vec![0; 36]),
        attested_at: Timestamp(0),
    });
    let (ScopedEntryDefIndex { zome_index, zome_type }, _) = entry_def_parts(&dummy)?;
    let filter = ChainQueryFilter::new()
        .entry_type(EntryType::App(AppEntryDef::new(zome_type, zome_index, EntryVisibility::Public)))
        .include_entries(true);
    query(filter)
}

#[hdk_extern]
pub fn get_receipt_for_leg(leg: ActionHash) -> ExternResult<Option<Record>> {
    // Local, not the default Network strategy: on a sparse/small network a
    // peer may not yet be a confirmed authority for this hash, so a live
    // network round-trip can come back empty even though gossip has already
    // delivered the data into local storage. Local reads whatever's already
    // arrived, which is what a retry loop here is actually waiting on.
    let links = get_links(
        LinkQuery::try_new(leg, LinkTypes::LegToReceipt)?,
        GetStrategy::Local,
    )?;
    let Some(link) = links.into_iter().next() else { return Ok(None) };
    let Some(action_hash) = link.target.into_action_hash() else { return Ok(None) };
    get(action_hash, GetOptions::local())
}

#[hdk_extern]
pub fn get_legs_for_order(order_ref: ActionHash) -> ExternResult<Vec<Record>> {
    let links = get_links(
        LinkQuery::try_new(order_ref, LinkTypes::OrderToLeg)?,
        GetStrategy::default(),
    )?;
    let mut legs = Vec::with_capacity(links.len());
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else { continue };
        if let Some(record) = get(action_hash, GetOptions::local())? {
            legs.push(record);
        }
    }
    Ok(legs)
}

/// Cross-zome entry point for `dispatch::complete_delivery` to gather every
/// attested receipt for an order's legs, before marking it Delivered.
/// Returns the receipt `ActionHash`es (not just a count) because
/// `dispatch_integrity`'s own `validate()` now re-derives and checks these
/// same references from the order entry's `delivery_receipts` field --
/// `complete_delivery` needs the actual hashes to populate that field, not
/// just a number to trust. Callable locally (same conductor, same agent)
/// without a capability grant, unlike the network-facing functions in
/// `countersigning.rs`.
#[hdk_extern]
pub fn list_attested_receipts_for_order(order_ref: ActionHash) -> ExternResult<Vec<ActionHash>> {
    let legs = get_legs_for_order(order_ref)?;
    let mut receipts = Vec::new();
    for leg_record in legs {
        if let Some(receipt_record) = get_receipt_for_leg(leg_record.action_address().clone())? {
            receipts.push(receipt_record.action_address().clone());
        }
    }
    Ok(receipts)
}
