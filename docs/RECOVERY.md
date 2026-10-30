# Accounts and recovery

How someone keeps their HandShake account when they change phones, and gets it back when they lose one, on a network with no company that could reset a password.

## The problem

A HandShake account is an agent key. Its private half lives in the keystore of the person's device (the Holochain runtime's lair), and the app never sees it. Changing phones, the old one can send the key on. Lose the device, though, and the key is gone: nothing peer-to-peer can bring it back, and nobody has a copy. With balances now real money, that loss can't be left to chance.

## Moving to a new phone: the same key

Moving to a new phone while the old one still works keeps the account's **own key**. The old phone sends the key to the new one, sealed so only the new phone can open it. The new phone then rebuilds the account's chain from the network (Holochain 0.7.1's `restore_from_dht`). It's the same account afterwards: the same balance, stores, listings, ratings, history and orders in progress. Nothing moves to a different key, so nothing has to be re-listed, handed on or reissued.

1. **The new phone invites.** Its keystore makes a one-time encryption key, and it shows the public half as a code (`handshake-move:1:…`) with a fingerprint.
2. **The old phone waits for the network.** It scans the code, and the person checks the fingerprint matches on both screens. The account zome's `ready_to_move` then has to say the network's authorities hold this device's latest action. A new phone restores only what the network holds, so nothing the old phone wrote can be left behind.
3. **The old phone stops.** The runtime disables the app: no zome calls, no background work, no answers to other devices. It then shows the account's key sealed to the invitation (`handshake-key:1:…`). The keystore seals it (lair's seed export, a crypto_box from the account key's encryption half to the invitation key), so the key is never readable in between. A photo of the code is useless without the new phone's keystore.
4. **The new phone takes it in.** Its keystore opens the key, checks it's the account the code names, and keeps it exportable, so it can move again. The runtime installs the app for that key with its chain restored, and enables it.
5. **The new phone sets itself up.** A restore brings back the chain but not what was private to the old device. The grants that let signals and handoff codes reach the device are private entries, and background work is the conductor's own state. Each zome's `prepare_device` writes them where they're missing, and nothing where they aren't; the app calls it on every start.
6. **The old phone lets go.** Once the person says the new phone has the account, the old one removes the app. Until then it can take the account back (`stay`), which it offers only with a warning: only if the new phone never finished.

**The one rule: never two phones at once.** Two devices writing with one key fork the account's chain, and the network then refuses the account for good: the new phone's install becomes unrecoverable, and peers flag the key. The steps above prevent it. The old phone stops before the key leaves, sends only once the network holds everything, and is never restarted while the new phone has the key. If it happens anyway, the account comes back the way a lost phone's does, by recovery (below), so the worst case is the same as losing the phone.

**What the network needs.** Holochain restores only a chain head at least two peers agree on (`restore_chain_quorum`), so a phone can't be fed a made-up history by one. With the old phone stopped, that means two other people's apps online that hold the account's history. On a live network they always are. A restore that can't find them yet keeps waiting, and the new phone says so. It also means a single node can't restore at all, so the development host stands in for this step (`web/src/holochain/devDevice.ts`). HOLOCHAIN_ISSUES.md #10 has the details.

**What a phone needs.** The keystore and the conductor's admin side are out of the UI's reach. The runtime hosting the app does this natively (`runtime/device`, the `handshake_device` crate) and gives the UI six commands as `window.__HANDSHAKE_DEVICE__` (see `web/src/holochain/device.ts`). The runtime also creates the account's key itself, exportable, because the conductor's own agent keys can't be exported. A runtime without these commands offers recovery instead.

## Recovery: an account is a line of keys

When the phone is **lost**, its key goes with it. Then the account carries on as a **new key with authority to speak for the old one**. A `Succession` entry on the new key's chain names the account it takes over and the authority it does so on. Validation (`account_integrity`) accepts three kinds of authority:

| Authority | When | What it rests on |
|---|---|---|
| **Recovery phrase** | The phone is lost | A signature by the key the person's twelve words derive, which their `RecoveryPlan` names |
| **Guardians** | The phone is lost | Vouches from at least the plan's threshold of the guardians it names, each from the guardian's own chain |

A plan counts only if it's the account's **latest** as of where the account stood (`head`, an action on its chain). So a phrase the person replaced, or a guardian they removed, can't recover them from that point on.

Each key takes over at most one account, so an account's history is a single line. Ratings and reputation for drivers and customers follow that line (the reputation zome reads the whole `lineage`). Stores are keyed by their catalog, so they don't move: see *What doesn't move yet*.

### Identity on the network, money through the issuer

The phrase or guardians prove *who* the person is, peer to peer. Validation alone can't safely move a lost key's **money**:

- **The old key can't be shown to be gone.** Validation sees only what it can fetch by hash. It can never prove an action *doesn't* exist, so it can't refuse the old key's future spending. A found or stolen phone could spend the same balance the new key inherits.
- **A phrase isn't single-use.** Whoever holds the words can sign for any number of new keys, and each would inherit the balance.

So a recovered account's balance is **reissued by an issuer**, the party that already holds the money behind it. That logic lives in the issuer service's `recovery.ts`:

- **Once per account.** The grant reference is `recovery:<old key>`, and a second recovery of the same account is marked contested and left to a person to review.
- **After a wait.** The old key must stay quiet for the issuer's published `recovery_wait_days` (default 7) from when the issuer first saw the request. Any activity on the old key restarts the wait.
- **For what the old key holds then, never more.**
- **Then what it was owed, a part at a time.** For 30 days after, the issuer also reissues what the old key was owed on its orders and never collected: a store's payment for food in flight, a driver's pay, a refund. See *Money owed to a lost key*.

Around that, honest apps treat a key whose account has moved on as finished:

- A store's app won't accept its orders, and a customer's app won't accept its bids (`dispatch::accounts::ensure_not_moved`).
- The issuer won't cash it out.
- The device itself shows "Your account has moved" (`MovedAway`).

## Residual risks

| Risk | Why it remains | What limits it |
|---|---|---|
| A thief with an unlocked lost phone spends its balance before recovery | The device's own key is still valid until the owner acts | The phone's lock, plus HandShake's passkey gate in development; recover promptly. |
| A thief keeps spending at a colluding store after recovery | Validation can't see the recovery | Honest stores refuse the key. The issuer's wait restarts on activity and it won't cash out a recovered key. Money only leaves through issuers. |
| Both phones use the account at once | A modified app, or taking the account back after the new phone already has it | The old phone stops before its key leaves and offers to take it back only with a warning. The network refuses a forked account: the person recovers it as they would a lost phone's. |
| Someone else uses the phrase or the guardians | The phrase *is* the account; guardians are trusted | The old device sees "Your account has moved". The issuer's wait gives the owner time to see it. Guardians are asked to vouch only after speaking to the person. A threshold over half means two different recoveries would each need a guardian who vouched for both, which their chain forbids. |
| An issuer reissues dishonestly | Issuers are trusted for money in and out | Their grants are public, and they're on the network's roster. |
| A plan names its guardians in public | Validation must see who may vouch | Names stay on the device (`guardianNames`); only keys are published. |

When Holochain's DPKI (Deepkey) returns, key revocation at the conductor level could make recovery's money move deterministically too. The `Succession` record is the natural thing to anchor it to.

## Stores

A store is authored by its merchant's key, and no key can change another's entries. Moving to a new phone keeps the key, so the store stays as it is. On a recovery, though, a store moves by being **republished** by the new key: `move_store` in the catalog zome copies its details, choice groups (nested ones remapped), menu and live promo codes into a store of the new key's own. A `StoreSuccession` ties old to new:

- Validation accepts it only from the key whose `Succession` took over the old store's owner, and each store moves once.
- Ratings follow the store's line (`store_line`), as a person's follow their keys. A move counts only while the succession behind it stands.
- Customers opening the old store are sent on to the new one, and Browse lists only the new one.
- The old listing's stake stays with the lost key.

### Money owed to a lost key

Money for an order sits in holds until each party collects their part, from their own device. A lost key never will, so its parts would sit there for good. The new key can't collect them in its place: the network allows each part once *per chain*, so a found or stolen old phone could collect the same part again, and the money would exist twice. So the issuer reissues them, part by part, with the same caution as the balance:

- **Read the way validation reads.** `dispatch::uncollected_by` reads the old key's history from the head the balance was reissued at, every action back, or fails (`ledger::decisions_of`). A read that misses a part the old key collected would pay it twice, so an incomplete read pays nothing.
- **Priced as collecting it would pay**, a store's settlement splitting food between store and refund as `ledger::collect` does. Only parts the old key would *collect*, on a valid hold and a valid basis; never ones it would give back or forfeit.
- **Only while the old key stays lost.** Before each grant, the issuer checks the old key has done nothing since that head. If it has, the watch stops and the recovery is left for a person: the key could collect what it's owed itself.
- **Once per part.** The grant's reference is `recovery:<old key>:<hold>:<part>`, recorded before it's granted, so a retry can't grant twice.
- **Review counts the whole account.** The balance and every part add up against the issuer's review limit, so an account can't come through in small parts; once a part is left for review, so is everything after it.
- **Bounded.** 60 days of orders, at most 500 of them, 20,000 actions of history; past that, a person looks.

## What doesn't move yet

Moving to a new phone keeps the key, so everything stays. On a recovery:

- **Money owed to the lost key that comes due more than 30 days after its balance was reissued.** The watch ends then.
- **Refunds that wait on the lost key.** A part its recipient must give back (an order a store cancelled) moves only when the recipient waives it, and a lost key never will. Letting the new key waive in its place is safe on its own, since giving money back can't create any, but not alongside the reissue above: the same part could then reach the payer *and* be reissued. Doing both needs the issuer to skip any part that's been waived, by either key.
- **A store's decisions.** Everyone's pay on a delivered order rests on the store's decision about it (`dispatch_types::issues`). If the store's key is lost before it decides, nothing on that order can settle.
- **Goodie bags** are short-lived and aren't copied.

## Where it lives

- `dnas/handshake/zomes/account/`: the plan, vouches, successions and parcels, with their validation.
- `dnas/handshake/zomes/catalog/coordinator/src/moves.rs`: moving a store (`StoreSuccession`).
- `dnas/handshake/zomes/account/coordinator/src/device.rs`: `ready_to_move`; each zome's `prepare_device`.
- `runtime/device/`: the runtime's side of moving to a new phone: keys, codes, restore.
- `dnas/handshake/zomes/ledger/`: `standing_at`.
- `dnas/handshake/zomes/dispatch/coordinator/src/accounts.rs`: honest apps refuse moved keys.
- `dnas/handshake/zomes/reputation/coordinator`: reputation follows the account's lineage.
- `issuer/src/recovery.ts`: the reissue sweep, the balance then what was owed; `payouts.ts` declines recovered keys' cash-outs.
- `dnas/handshake/zomes/dispatch/coordinator/src/settlement.rs`: `uncollected_by`; `ledger`'s `decisions_of`.
- `web/src/routes/Account.tsx`: Account & recovery.
- `web/src/components/RestoreAccount.tsx`: "I already have an account".
- `web/src/lib/account/recoveryPhrase.ts`: BIP-39 words in ten languages, and HKDF under HandShake's own label to Ed25519.
- `web/src/holochain/device.ts`: the runtime's commands to the UI; `devDevice.ts`, development's stand-in.
- `web/src/components/Departure.tsx`: the old phone, once it has sent its key.
- Tests:
  - `tests/tryorama/src/device-move.test.ts`: moving to a new phone: ready only once published, the restore, the device set up, the same account carrying on;
  - `runtime/device`: the key moving between real keystores (unit), and between real conductors (`tests/move.rs`, with `--ignored`);
  - `web/test/deviceMove.test.ts`: the codes, as the runtime writes them;
  - `tests/tryorama/src/account.test.ts`: every authority, and the forgeries a modified app would try;
  - `tests/tryorama/src/store-move.test.ts`: a faithful copy, the move's forgeries;
  - `issuer/test/service.test.ts`: reissue rules, and what was owed: once per part, stopped by the old key acting, reviewed as a whole, never from a partial read;
  - `tests/tryorama/src/uncollected.test.ts`: what a lost key was owed, from its own history: what it collected isn't owed, what it couldn't is, priced right, read only from its own chain;
  - `web/test/recoveryPhrase.test.ts`.
