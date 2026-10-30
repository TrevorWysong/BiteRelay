//! What a Relay runtime -- the desktop or phone app that embeds the
//! conductor and its keystore and shows Relay's UI -- does natively to move
//! an account to a new phone with the same key. The UI can't: it speaks
//! only the conductor's App API, and never sees a key. See docs/RECOVERY.md for
//! the whole flow, and `web/src/holochain/device.ts` for the UI's side of
//! the contract: each method of `Device` is one command the runtime exposes
//! to it, taking and returning strings.
//!
//! In order, with the UI around it:
//!
//! 1. The new phone (`invite`) shows an invitation code.
//! 2. The old phone's UI waits until the network holds everything it wrote
//!    (the account zome's `ready_to_move`), then scans it; the runtime
//!    (`send`) stops the app for good -- nothing more may be written from
//!    here -- and shows the account's key sealed to the invitation.
//! 3. The new phone scans that (`receive`): the key goes into its keystore,
//!    and the app is installed for it, its chain restored from the network.
//!    The UI then sets the device up (each zome's `prepare_device`).
//! 4. The old phone, once the person confirms the new one has it, removes
//!    the app (`retire`). Until then it can still take the account back
//!    (`stay`), which the UI offers only while the new phone hasn't used
//!    the key.

pub mod code;
pub mod keys;
pub mod node;

use code::{Invitation, SealedKey};
use holochain_client::AdminWebsocket;
use holochain_types::prelude::AgentPubKey;
use lair_keystore_api::LairClient;
use node::App;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("That isn't a code from Relay's move to a new phone.")]
    BadCode,
    #[error("This device's keystore doesn't hold that key.")]
    NoSuchKey,
    #[error("This account's key can't be moved: recover the account on the new phone with your recovery phrase or guardians instead.")]
    NotExportable,
    #[error("The key that opened isn't the account the code names.")]
    WrongAccount,
    #[error("Show the code from this phone again: the one it was sealed to is gone.")]
    NoInvitation,
    #[error("Your account's history hasn't arrived yet: it comes from other people's apps on the network. Keep Relay open and online; it carries on where it left off.")]
    StillRestoring,
    #[error("This account was used on two phones at once, and the network has locked it. Recover it with your recovery phrase or guardians: {0}")]
    Unrecoverable(String),
    #[error("keystore: {0}")]
    Keystore(String),
    #[error("conductor: {0}")]
    Conductor(String),
}

impl From<lair_keystore_api::dependencies::one_err::OneErr> for Error {
    fn from(err: lair_keystore_api::dependencies::one_err::OneErr) -> Self {
        Error::Keystore(err.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// How long `receive` waits for a restore before handing back
/// `StillRestoring` -- the restore itself carries on, and a later
/// `receive` picks it up.
pub const RESTORE_PATIENCE: Duration = Duration::from_secs(120);

/// One device's side of moving its account.
pub struct Device {
    lair: LairClient,
    admin: AdminWebsocket,
    app: App,
    /// The invitation this device last showed, by its keystore tag.
    invitation: Mutex<Option<Arc<str>>>,
}

impl Device {
    pub fn new(lair: LairClient, admin: AdminWebsocket, app: App) -> Self {
        Self { lair, admin, app, invitation: Mutex::new(None) }
    }

    /// A first launch: a new account, with a key that can move later.
    pub async fn start_account(&self) -> Result<AgentPubKey> {
        if let Some(info) = node::app_info(&self.admin, &self.app).await? {
            return Ok(info.agent_pub_key);
        }
        let agent = keys::new_account_key(&self.lair).await?;
        node::install_new(&self.admin, &self.app, &agent).await?;
        Ok(agent)
    }

    /// Whether this device's account can move by its key.
    pub async fn can_move(&self) -> Result<bool> {
        let Some(info) = node::app_info(&self.admin, &self.app).await? else { return Ok(false) };
        for entry in self.lair.list_entries().await? {
            if let lair_keystore_api::lair_store::LairEntryInfo::Seed { seed_info, .. } = entry {
                if AgentPubKey::from_raw_32(seed_info.ed25519_pub_key.0.to_vec()) == info.agent_pub_key {
                    return Ok(seed_info.exportable);
                }
            }
        }
        Ok(false)
    }

    /// The new phone: an invitation code to show the old one.
    pub async fn invite(&self) -> Result<String> {
        let (tag, invitation) = keys::invite(&self.lair).await?;
        *self.invitation.lock().await = Some(tag);
        Ok(invitation.encode())
    }

    /// The old phone: stops the app for good, and seals the account's key
    /// to `invitation`. The UI checks `ready_to_move` first.
    pub async fn send(&self, invitation: &str) -> Result<String> {
        let invitation = Invitation::decode(invitation)?;
        let info = node::app_info(&self.admin, &self.app).await?.ok_or(Error::NoSuchKey)?;
        let account = info.agent_pub_key;
        if !self.can_move().await? {
            return Err(Error::NotExportable);
        }
        node::freeze(&self.admin, &self.app).await?;
        match keys::seal(&self.lair, &account, &invitation).await {
            Ok(sealed) => Ok(sealed.encode()),
            Err(err) => {
                node::thaw(&self.admin, &self.app).await?;
                Err(err)
            }
        }
    }

    /// The old phone: takes the account back, the new phone not having
    /// used the key.
    pub async fn stay(&self) -> Result<()> {
        node::thaw(&self.admin, &self.app).await
    }

    /// The old phone: the account lives on the new one now.
    pub async fn retire(&self) -> Result<()> {
        node::retire(&self.admin, &self.app).await
    }

    /// The new phone: takes in the key `sealed` carries and restores the
    /// account from the network. Safe to repeat while it restores.
    pub async fn receive(&self, sealed: &str) -> Result<AgentPubKey> {
        let sealed = SealedKey::decode(sealed)?;
        let tag = self.invitation.lock().await.clone().ok_or(Error::NoInvitation)?;
        let account = keys::receive(&self.lair, &tag, &sealed).await?;
        node::restore(&self.admin, &self.app, &account, RESTORE_PATIENCE).await?;
        Ok(account)
    }
}
