//! The two codes phones show each other to move an account (RECOVERY.md),
//! as QR codes or text. The app reads them too, to show fingerprints and to
//! refuse anything else early (`web/src/lib/deviceMove.ts`, which must
//! agree with this).
//!
//! - An **invitation**, shown by the new phone: the public half of a
//!   one-time encryption key in its keystore. `relay-move:1:` and the key.
//! - A **sealed key**, shown by the old phone: the account's key encrypted
//!   to that invitation, so only the phone that showed it can open it.
//!   `relay-key:1:` and the account, the sender's encryption key, the nonce
//!   and the ciphertext, together.
//!
//! Both are base64url without padding.

use crate::{Error, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use holochain_types::prelude::AgentPubKey;

pub const INVITATION_PREFIX: &str = "relay-move:1:";
pub const SEALED_KEY_PREFIX: &str = "relay-key:1:";

/// Holochain's prefix for an agent key.
const AGENT_PREFIX: [u8; 3] = [0x84, 0x20, 0x24];
const NONCE_BYTES: usize = 24;
/// The smallest ciphertext there is: crypto_box's tag around nothing.
const MIN_CIPHER_BYTES: usize = 17;

/// The new phone's invitation: where to seal the account's key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invitation {
    pub key: [u8; 32],
}

impl Invitation {
    pub fn encode(&self) -> String {
        format!("{INVITATION_PREFIX}{}", URL_SAFE_NO_PAD.encode(self.key))
    }

    pub fn decode(code: &str) -> Result<Self> {
        let bytes = body(code, INVITATION_PREFIX)?;
        let key = <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| Error::BadCode)?;
        Ok(Self { key })
    }
}

/// The account's key, sealed to an invitation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedKey {
    /// The account the key is: checked against what opens.
    pub account: AgentPubKey,
    pub sender: [u8; 32],
    pub nonce: [u8; NONCE_BYTES],
    pub cipher: Vec<u8>,
}

impl SealedKey {
    pub fn encode(&self) -> String {
        let bytes = [self.account.get_raw_39(), &self.sender, &self.nonce, &self.cipher].concat();
        format!("{SEALED_KEY_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))
    }

    pub fn decode(code: &str) -> Result<Self> {
        let bytes = body(code, SEALED_KEY_PREFIX)?;
        if bytes.len() < 39 + 32 + NONCE_BYTES + MIN_CIPHER_BYTES || bytes[..3] != AGENT_PREFIX {
            return Err(Error::BadCode);
        }
        let account = AgentPubKey::try_from_raw_39(bytes[..39].to_vec()).map_err(|_| Error::BadCode)?;
        let sender = bytes[39..71].try_into().map_err(|_| Error::BadCode)?;
        let nonce = bytes[71..71 + NONCE_BYTES].try_into().map_err(|_| Error::BadCode)?;
        Ok(Self { account, sender, nonce, cipher: bytes[71 + NONCE_BYTES..].to_vec() })
    }
}

fn body(code: &str, prefix: &str) -> Result<Vec<u8>> {
    let encoded = code.trim().strip_prefix(prefix).ok_or(Error::BadCode)?;
    URL_SAFE_NO_PAD.decode(encoded).map_err(|_| Error::BadCode)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> AgentPubKey {
        AgentPubKey::from_raw_32(vec![9; 32])
    }

    #[test]
    fn an_invitation_round_trips() {
        let invitation = Invitation { key: [3; 32] };
        assert!(invitation.encode().starts_with(INVITATION_PREFIX));
        assert_eq!(Invitation::decode(&format!("  {}\n", invitation.encode())).unwrap(), invitation);
    }

    #[test]
    fn a_sealed_key_round_trips() {
        let sealed = SealedKey { account: account(), sender: [1; 32], nonce: [2; 24], cipher: vec![5; 48] };
        assert_eq!(SealedKey::decode(&sealed.encode()).unwrap(), sealed);
    }

    /// The same codes `web/test/deviceMove.test.ts` reads: the app and the
    /// runtime agree on the form.
    pub const SEALED_FIXTURE: &str = "relay-key:1:hCAkCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQldqCMwAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQECAgICAgICAgICAgICAgICAgICAgICAgIFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU";
    pub const INVITATION_FIXTURE: &str = "relay-move:1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    #[test]
    fn the_app_reads_the_same_codes() {
        let sealed = SealedKey { account: account(), sender: [1; 32], nonce: [2; 24], cipher: vec![5; 48] };
        assert_eq!(sealed.encode(), SEALED_FIXTURE);
        assert_eq!(Invitation { key: core::array::from_fn(|i| i as u8) }.encode(), INVITATION_FIXTURE);
    }

    #[test]
    fn anything_else_is_refused() {
        let sealed = SealedKey { account: account(), sender: [1; 32], nonce: [2; 24], cipher: vec![5; 48] }.encode();
        for code in ["", "relay-move:1:", "relay-move:1:AAAA", "relay-move:2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "relay-account:uhCAk", &sealed[..40]] {
            assert!(Invitation::decode(code).is_err() && SealedKey::decode(code).is_err(), "{code}");
        }
        assert!(Invitation::decode(&sealed).is_err(), "one code isn't the other");
    }
}
