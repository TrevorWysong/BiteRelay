//! The account's key in the device's keystore (lair), and moving it to
//! another device's keystore without it ever being readable in between.
//!
//! The conductor makes agent keys that can't be exported, so a runtime
//! makes the account's key itself (`new_account_key`), exportable, and
//! installs the app with it. Moving it is lair's own seed export: sealed
//! (crypto_box) from the account key's encryption half to an invitation
//! key the new device's keystore made, and opened only there.

use crate::code::{Invitation, SealedKey};
use crate::{Error, Result};
use holochain_types::prelude::AgentPubKey;
use lair_keystore_api::prelude::*;
use std::sync::Arc;

/// Every account key's tag starts so; the rest keeps tags unique.
pub const ACCOUNT_TAG_PREFIX: &str = "relay-account:";
/// And every invitation key's.
pub const INVITATION_TAG_PREFIX: &str = "relay-invitation:";

fn fresh_tag(prefix: &str) -> Arc<str> {
    format!("{prefix}{}", uuid::Uuid::new_v4()).into()
}

fn agent_of(seed: &SeedInfo) -> AgentPubKey {
    AgentPubKey::from_raw_32(seed.ed25519_pub_key.0.to_vec())
}

/// A new account key, exportable, for a first install.
pub async fn new_account_key(lair: &LairClient) -> Result<AgentPubKey> {
    let seed = lair.new_seed(fresh_tag(ACCOUNT_TAG_PREFIX), None, true).await?;
    Ok(agent_of(&seed))
}

/// The keystore's entry for `account`: its tag and seed.
async fn account_seed(lair: &LairClient, account: &AgentPubKey) -> Result<(Arc<str>, SeedInfo)> {
    for entry in lair.list_entries().await? {
        if let LairEntryInfo::Seed { tag, seed_info } = entry {
            if agent_of(&seed_info) == *account {
                return Ok((tag, seed_info));
            }
        }
    }
    Err(Error::NoSuchKey)
}

/// A one-time invitation key, and its tag -- which the new device keeps to
/// open what's sealed to it.
pub async fn invite(lair: &LairClient) -> Result<(Arc<str>, Invitation)> {
    let tag = fresh_tag(INVITATION_TAG_PREFIX);
    let seed = lair.new_seed(tag.clone(), None, false).await?;
    Ok((tag, Invitation { key: *seed.x25519_pub_key.0 }))
}

/// `account`'s key, sealed to `invitation`.
pub async fn seal(lair: &LairClient, account: &AgentPubKey, invitation: &Invitation) -> Result<SealedKey> {
    let (tag, seed) = account_seed(lair, account).await?;
    if !seed.exportable {
        return Err(Error::NotExportable);
    }
    let (nonce, cipher) = lair.export_seed_by_tag(tag, seed.x25519_pub_key.clone(), invitation.key.into(), None).await?;
    Ok(SealedKey { account: account.clone(), sender: *seed.x25519_pub_key.0, nonce, cipher: cipher.to_vec() })
}

/// Opens `sealed` with the invitation key tagged `invitation`, into this
/// keystore -- exportable, so it can move again. Refuses a key that isn't
/// the account the code names.
pub async fn receive(lair: &LairClient, invitation: &str, sealed: &SealedKey) -> Result<AgentPubKey> {
    let LairEntryInfo::Seed { seed_info: invitation_seed, .. } = lair.get_entry(invitation.into()).await? else {
        return Err(Error::NoSuchKey);
    };
    // Already here: an earlier try that lost its answer.
    if account_seed(lair, &sealed.account).await.is_ok() {
        return Ok(sealed.account.clone());
    }
    let seed = lair
        .import_seed(sealed.sender.into(), invitation_seed.x25519_pub_key, None, sealed.nonce, sealed.cipher.clone().into(), fresh_tag(ACCOUNT_TAG_PREFIX), true)
        .await?;
    let opened = agent_of(&seed);
    if opened != sealed.account {
        return Err(Error::WrongAccount);
    }
    Ok(opened)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lair_keystore_api::dependencies::{hc_seed_bundle, sodoken};
    use lair_keystore_api::in_proc_keystore::InProcKeystore;
    use lair_keystore_api::mem_store::create_mem_store_factory;
    use std::sync::Mutex;

    async fn keystore() -> LairClient {
        let passphrase = Arc::new(Mutex::new(sodoken::LockedArray::from(b"passphrase".to_vec())));
        let config = hc_seed_bundle::PwHashLimits::Minimum.with_exec(|| LairServerConfigInner::new("/", passphrase.clone())).await.unwrap();
        InProcKeystore::new(Arc::new(config), create_mem_store_factory(), passphrase).await.unwrap().new_client().await.unwrap()
    }

    async fn signs_the_same(a: &LairClient, b: &LairClient, account: &AgentPubKey) -> bool {
        let key: Ed25519PubKey = <[u8; 32]>::try_from(account.get_raw_32()).unwrap().into();
        let message: Arc<[u8]> = b"same account".to_vec().into();
        let one = a.sign_by_pub_key(key.clone(), None, message.clone()).await.unwrap();
        let two = b.sign_by_pub_key(key, None, message).await.unwrap();
        one == two
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_account_key_moves_to_the_invited_keystore_only() {
        let (old, new, stranger) = (keystore().await, keystore().await, keystore().await);
        let account = new_account_key(&old).await.unwrap();
        let (tag, invitation) = invite(&new).await.unwrap();
        let sealed = SealedKey::decode(&seal(&old, &account, &invitation).await.unwrap().encode()).unwrap();

        let (stranger_tag, _) = invite(&stranger).await.unwrap();
        assert!(receive(&stranger, &stranger_tag, &sealed).await.is_err(), "another keystore can't open it");

        assert_eq!(receive(&new, &tag, &sealed).await.unwrap(), account);
        assert!(signs_the_same(&old, &new, &account).await, "the new device holds the very same key");
        assert_eq!(receive(&new, &tag, &sealed).await.unwrap(), account, "safe to repeat");

        let (back, invitation) = invite(&old).await.unwrap();
        let again = seal(&new, &account, &invitation).await.unwrap();
        assert!(receive(&old, &back, &again).await.is_ok(), "and it can move on again");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_key_the_conductor_made_doesnt_move() {
        let old = keystore().await;
        let seed = old.new_seed("made by the conductor".into(), None, false).await.unwrap();
        let (_, invitation) = invite(&keystore().await).await.unwrap();
        assert!(matches!(seal(&old, &agent_of(&seed), &invitation).await, Err(Error::NotExportable)));
        assert!(matches!(seal(&old, &AgentPubKey::from_raw_32(vec![1; 32]), &invitation).await, Err(Error::NoSuchKey)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_code_naming_another_account_is_refused() {
        let (old, new) = (keystore().await, keystore().await);
        let account = new_account_key(&old).await.unwrap();
        let (tag, invitation) = invite(&new).await.unwrap();
        let mut sealed = seal(&old, &account, &invitation).await.unwrap();
        sealed.account = AgentPubKey::from_raw_32(vec![1; 32]);
        assert!(matches!(receive(&new, &tag, &sealed).await, Err(Error::WrongAccount)));
    }
}
