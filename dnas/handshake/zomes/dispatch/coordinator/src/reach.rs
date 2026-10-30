//! How far something this agent wrote has got: written only on this device
//! so far, or checked and held by peers. A write succeeds the moment it's
//! on the author's own chain; nobody else can see it until it's published
//! and peers have validated it -- which, on a phone that's just lost
//! signal, can take a while. Each peer that validates one of a write's ops
//! sends back a signed validation receipt, and Holochain keeps them on the
//! author's node: this reads them.

use hdk::prelude::*;

#[derive(Serialize, Deserialize, Debug)]
pub struct NetworkReach {
    /// How many distinct peers have validated one of the write's ops.
    pub peers: u32,
    /// Whether every op has all the receipts Holochain asks for -- the
    /// write is as public as it'll get.
    pub complete: bool,
}

/// How far `action_hash` has reached -- `None` unless this agent wrote it
/// (only the author's node collects its receipts).
#[hdk_extern]
pub fn network_reach(action_hash: ActionHash) -> ExternResult<Option<NetworkReach>> {
    let Some(record) = get(action_hash.clone(), GetOptions::local())? else { return Ok(None) };
    if record.action().author() != &agent_info()?.agent_initial_pubkey {
        return Ok(None);
    }
    let sets = get_validation_receipts(GetValidationReceiptsInput::new(action_hash))?;
    let mut peers: Vec<AgentPubKey> = Vec::new();
    for receipt in sets.iter().flat_map(|set| &set.receipts) {
        if receipt.validation_status != ValidationStatus::Valid {
            continue;
        }
        for validator in &receipt.validators {
            if !peers.contains(validator) {
                peers.push(validator.clone());
            }
        }
    }
    let complete = !sets.is_empty() && sets.iter().all(|set| set.receipts_complete);
    Ok(Some(NetworkReach { peers: peers.len() as u32, complete }))
}
