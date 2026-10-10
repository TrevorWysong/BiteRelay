//! Sealed fields: data only its two parties can open. Validation can't see
//! inside one, but it bounds its size, so no one can make every peer store
//! an unbounded blob.
//!
//! The conductor seals at most `SEAL_CHUNK_BYTES` in one box. A small field
//! (a note, a name, an address, a code) is one box; one that can hold a
//! photo is `SealedChunks`, a box per chunk.

use crate::limits::{MAX_SEALED_BYTES, SEALED_IMAGE_OVERHEAD_BYTES, SEAL_CHUNK_BYTES, SEAL_TAG_BYTES};
use hdi::prelude::*;

/// A value sealed between two agents in order, a box per
/// `SEAL_CHUNK_BYTES` of it -- for anything that may be larger than one box
/// holds (a photo). Sealed with `relay_coordinator_support::seal_chunked`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SealedChunks(pub Vec<XSalsa20Poly1305EncryptedData>);

/// Why a one-box sealed field is unacceptable, if it is: more ciphertext
/// than `max_bytes`.
pub fn sealed_problem(field: &'static str, sealed: &XSalsa20Poly1305EncryptedData, max_bytes: usize) -> Option<String> {
    (sealed.as_encrypted_data_ref().len() > max_bytes).then(|| format!("{field} is too large"))
}

/// Why a chunked sealed field is unacceptable, if it is: empty, more chunks
/// than `max_plaintext` bytes need, a box larger than one chunk seals to, or
/// more ciphertext in all than `max_plaintext` seals to.
pub fn sealed_chunks_problem(field: &'static str, sealed: &SealedChunks, max_plaintext: usize) -> Option<String> {
    let chunks = &sealed.0;
    let total: usize = chunks.iter().map(|c| c.as_encrypted_data_ref().len()).sum();
    let fits = !chunks.is_empty()
        && chunks.len() <= max_plaintext.div_ceil(SEAL_CHUNK_BYTES)
        && chunks.iter().all(|c| c.as_encrypted_data_ref().len() <= MAX_SEALED_BYTES)
        && total <= max_plaintext + chunks.len() * SEAL_TAG_BYTES;
    (!fits).then(|| format!("{field} is too large"))
}

/// The most a sealed field holding an image (and a little text) may hold,
/// before sealing.
pub fn max_sealed_image_bytes() -> usize {
    relay_governance::max_image_bytes() + SEALED_IMAGE_OVERHEAD_BYTES
}
