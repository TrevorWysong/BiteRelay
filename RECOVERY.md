# Accounts and recovery

How someone keeps their Relay account when they change phones, and gets it back when they lose one, on a network with no company that could reset a password.

## The problem

A Relay account is an agent key. Its private half lives in the keystore of the person's device (the Holochain runtime's lair), and the app never sees it. Lose the device and the key is gone: nothing peer-to-peer can bring it back, and nobody has a copy. With balances now real money, that loss can't be left to chance.

## The model: an account is a line of keys

An account carries on as a **new key with authority to speak for the old one**. A `Succession` entry on the new key's chain names the account it takes over and the authority it does so on. Validation (`account_integrity`) accepts three kinds of authority:

| Authority | When | What it rests on |
|---|---|---|
| **Hand-over** | Moving to a new phone while the old one still works | The old key's own final ledger entry, `HandOver { successor }`, naming the new key |
| **Recovery phrase** | The phone is lost | A signature by the key the person's twelve words derive, which their `RecoveryPlan` names |
| **Guardians** | The phone is lost | Vouches from at least the plan's threshold of the guardians it names, each from the guardian's own chain |

A plan counts only if it's the account's **latest** as of where the account stood (`head`, an action on its chain). So a phrase the person replaced, or a guardian they removed, can't recover them from that point on.

Each key takes over at most one account, so an account's history is a single line. Ratings and reputation for drivers and customers follow that line (the reputation zome reads the whole `lineage`). Stores are keyed by their catalog, so they don't move: see *What doesn't move yet*.

## Moving to a new device: fully on the network

1. The new device shows its code: its key, as a QR code with a fingerprint to compare.
2. The old device scans it and hands over, in one commit:
   - a `Parcel` sealed to the new key, holding what only the old key could read (name, phone, saved addresses, favourites);
   - the ledger's `HandOver`: the whole balance, which can't be below zero, with no order in hand.
3. Nothing may follow a `HandOver` on the old key's ledger. That's validated: a modified app can't spend from the old key either.
4. The new device takes over (`Succession { HandOver }`) and, in the same commit, takes in the balance (`Inherit`), once.

Nothing here needs trust. It's deterministic: every step is validated against the chains involved.

## Recovery: identity on the network, money through the issuer

The phrase or guardians prove *who* the person is, peer to peer. Validation alone can't safely move a lost key's **money**:

- **The old key can't be shown to be gone.** Validation sees only what it can fetch by hash. It can never prove an action *doesn't* exist, so it can't refuse the old key's future spending. A found or stolen phone could spend the same balance the new key inherits.
- **A phrase isn't single-use.** Whoever holds the words can sign for any number of new keys, and each would inherit the balance.

So a recovered account's balance is **reissued by an issuer**, the party that already holds the money behind it. That logic lives in the issuer service's `recovery.ts`:

- **Once per account.** The grant reference is `recovery:<old key>`, and a second recovery of the same account is marked contested and left to a person to review.
- **After a wait.** The old key must stay quiet for the issuer's published `recovery_wait_days` (default 7) from when the issuer first saw the request. Any activity on the old key restarts the wait.
- **For what the old key holds then, never more.**

Around that, honest apps treat a key whose account has moved on as finished:

- A store's app won't accept its orders, and a customer's app won't accept its bids (`dispatch::accounts::ensure_not_moved`).
- The issuer won't cash it out. A key that *handed over* is still paid: it was its owner.
- The device itself shows "Your account has moved" (`MovedAway`).

## Residual risks

| Risk | Why it remains | What limits it |
|---|---|---|
| A thief with an unlocked lost phone spends its balance before recovery | The device's own key is still valid until the owner acts | The phone's lock, plus Relay's passkey gate in development; recover promptly. |
| A thief keeps spending at a colluding store after recovery | Validation can't see the recovery | Honest stores refuse the key. The issuer's wait restarts on activity and it won't cash out a recovered key. Money only leaves through issuers. |
| Someone else uses the phrase or the guardians | The phrase *is* the account; guardians are trusted | The old device sees "Your account has moved". The issuer's wait gives the owner time to see it. Guardians are asked to vouch only after speaking to the person. A threshold over half means two different recoveries would each need a guardian who vouched for both, which their chain forbids. |
| An issuer reissues dishonestly | Issuers are trusted for money in and out | Their grants are public, and they're on the network's roster. |
| A plan names its guardians in public | Validation must see who may vouch | Names stay on the device (`guardianNames`); only keys are published. |

When Holochain's DPKI (Deepkey) returns, key revocation at the conductor level could make recovery's money move deterministically too. The `Succession` record is the natural thing to anchor it to.

## Stores

A store is authored by its merchant's key, and no key can change another's entries. So a store moves by being **republished** by the new key: `move_store` in the catalog zome copies its details, choice groups (nested ones remapped), menu and live promo codes into a store of the new key's own. A `StoreSuccession` ties old to new:

- Validation accepts it only from the key whose `Succession` took over the old store's owner, and each store moves once.
- Ratings follow the store's line (`store_line`), as a person's follow their keys. A move counts only while the succession behind it stands.
- Customers opening the old store are sent on to the new one, and Browse lists only the new one.
- **On a hand-over**, the old phone closes the store's listing first, so the listing stake comes back with the balance. The new phone lists the moved store again.
- **On a recovery**, the old listing's stake stays with the lost key.

## What doesn't move yet

- **Money owed to the old key mid-order** (a refund, a store's payment for food in flight) stays with the old key. Finish orders before moving. A recovered key's uncollected parts aren't reissued.
- **Goodie bags** are short-lived and aren't copied.

## Where it lives

- `dnas/relay/zomes/account/`: the plan, vouches, successions and parcels, with their validation.
- `dnas/relay/zomes/catalog/coordinator/src/moves.rs`: moving a store (`StoreSuccession`).
- `dnas/relay/zomes/ledger/`: `HandOver`, `Inherit`, `standing_at`.
- `dnas/relay/zomes/dispatch/coordinator/src/accounts.rs`: honest apps refuse moved keys.
- `dnas/relay/zomes/reputation/coordinator`: reputation follows the account's lineage.
- `issuer/src/recovery.ts`: the reissue sweep; `payouts.ts` declines recovered keys' cash-outs.
- `web/src/routes/Account.tsx`: Account & recovery.
- `web/src/components/RestoreAccount.tsx`: "I already have an account".
- `web/src/lib/recoveryPhrase.ts`: BIP-39 words in ten languages, and HKDF under Relay's own label to Ed25519.
- Tests:
  - `tests/tryorama/src/account.test.ts`: every authority, and the forgeries a modified app would try;
  - `tests/tryorama/src/store-move.test.ts`: a faithful copy, the move's forgeries;
  - `issuer/test/service.test.ts`: reissue rules;
  - `web/test/recoveryPhrase.test.ts`.
