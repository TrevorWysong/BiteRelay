# Upgrading the network

How HandShake ships a change to its rules without stranding anyone's money, history or store.

## Two kinds of change

- **Coordinator changes** (anything outside the integrity zomes: screens, reads, workflows) keep the DNA hash. Ship a new app version, and runtimes swap the new code in. Nothing moves, and the network carries on. Most changes are this kind.
- **Integrity changes** (entry types, link types, validation, DNA properties) produce a new DNA, which is a **new network**. Validation on one network can't read another, so people have to *move* to it. This document is about that.

Keep integrity changes rare: batch them into network versions, and prefer additive changes (a new entry type, a field with `#[serde(default)]`). Every DNA version is a migration everyone has to make.

## The protocol

Holochain 0.7 provides the primitives:
- `close_chain` writes a final action that names the new DNA;
- the network's agent-activity authorities reject anything after it;
- init properties can seed a new chain.

HandShake builds account migration on top of them.

Holochain 0.7.1 adds a fourth, which HandShake uses within a network rather than between them: installing an app with `restore_from_dht` rebuilds an existing key's chain on a new device -- how an account moves to a new phone with its key (RECOVERY.md).

### 1. Announcing the new network

The issuer runs on both networks (the same key, on both rosters). On the old network, it publishes its profile with `next_network`, the new DNA's hash. The service does this itself when `PREVIOUS_ISSUER_APP_ID` names its app there. Old apps then show "A new version of HandShake is out" (a banner, plus Account & recovery → New version).

### 2. Leaving the old network

The person installs the new version, chooses "I already have an account" → "From the previous version", and the new version shows its code. In the old version, they scan or paste that code. The old app then makes one call, `account::migrate_out`:

- It refuses while something would be stranded:
  - orders in progress, in any role;
  - a listed store, whose stake comes back only to this key. The app closes listings first.
- It seals a **parcel** to the new key: the person's name, phone, saved addresses and favourites, which only the old key could read.
- It writes a validated **`Migration`** entry naming the new network and the new key, with links for the issuer and for the new key.
- It **closes the chain** (`close_chain`).

Holochain rejects anything after the close: since 0.7.1 the author's own conductor refuses to write it, and the network's authorities reject it. Validation of a *record* doesn't check that, though, so a counterparty fetching a hold written after the close wouldn't notice. So the ledger checks for itself: its validation walks the author's chain since their previous ledger entry, and refuses any entry after a `CloseChain`. The old key can never move money again, even from a modified app.

### 3. Carrying the balance

Money can't cross networks on validation's word. The issuer, which holds the money behind it, carries it (`issuer/src/migrations.ts`):
- It sweeps the old network's migration requests.
- It waits until each one's chain close is seen. Because the close is final, there's no waiting period, unlike a recovery.
- It credits what the ledger held at the close (`ledger::standing_at`) to the new key on the new network.
- It does this once per account: the grant reference is `migration:<old key>`, and the service records each one.

### 4. Arriving

A release made while people move carries the previous network as a second app role, `previous`, built from that release's exact bundle: `npm run package -- --previous deploy/releases/<previous>`. The new key gets a cell there too, so the new app can read the old network directly:

- **`arrive`** records an `Arrival` on the new network, naming the old account and its migration.
- **`arrived_from`** checks it *on the previous network*, through a bridge call to the `previous` role. The migration has to exist, be the old account's, name this key and this network, and its chain has to be closed. Validation on the new network can't read the old one, so apps check this whenever they read it, the same way a recovery has to still stand.
- **The parcel** is opened on the previous network, and the profile is re-created from it plus the old public profile.
- **Stores** are republished by `catalog::import_store`, reading the old store through the bridge: details, choice groups, menu and live promo codes, every reference remapped. A `StoreImport` records where each one came from.
- **Ratings and reputation**, for people and for stores, add the previous network's summaries once `arrived_from` / `imported_from` confirm the link.

### What doesn't move, and the limits

- **Money owed mid-order.** Moving out is refused while orders are active, and a store must close its listings first.
- **Recovery plans, guardians and vouches** are network-scoped. People set them up again on the new network. The app could carry the plan in the parcel; that's not done yet.
- **History reaches back one version.** The new app reads the network just before it. To reach further back, a release would carry more than one previous role.
- **Who carries the money.** If several issuers announce the same next network, each carries only the requests made to it (the account picks one), so nobody is paid twice. Running two migrations to different next networks at once isn't supported.
- **The old network has to stay up during the move.** Its peers serve the history the new network reads. Keep the issuer's old conductor, and the old bootstrap and relay servers, running until everyone who's going to move has moved. History on the old network lasts as long as some peers still hold it.

## For the operator, step by step

1. Build the new release with the changed integrity zomes and the same issuers in `deploy/properties.json`. Use a new network seed, such as `handshake-2027`, and carry the previous release:
   - `npm run package -- --network-seed handshake-2027 --previous deploy/releases/handshake-2026`
   - Every release writes `deploy/handshake.happ` and `deploy/handshake.network.json`. Keep both for each release, in `deploy/releases/<name>/`.
2. On the issuer's machine:
   - install the new network for the issuer's key: `node issuer/scripts/provision.mjs install deploy/handshake.happ`, with a new `ISSUER_APP_ID`;
   - set `PREVIOUS_ISSUER_APP_ID` to the old app's id;
   - restart the service. It announces the new network on the old one and carries balances over.
3. Ship the new release. People move when they open it.
4. Once moving has tailed off, stop the issuer's old app. A later release can drop the `previous` role.

## Where it lives

- `dnas/handshake/zomes/account/coordinator/src/migration.rs`: `migrate_out`, `chain_closed`, `get_migration_requests`, `arrive`, `arrived_from`. The `Migration` and `Arrival` entries are in `account_types`.
- `dnas/handshake/zomes/ledger/integrity`: refuses ledger entries after a chain close.
- `dnas/handshake/zomes/catalog/coordinator/src/moves.rs`: `import_store`, `imported_from` (and the shared store copy).
- `dnas/handshake/zomes/reputation/coordinator`: adds the previous network's summaries.
- `issuer/src/migrations.ts`: carries balances over.
- `web/scripts/package.mjs`: `--previous`.
- Web:
  - `routes/Account.tsx`, the move sheet in the old version;
  - `components/RestoreAccount.tsx`, "From the previous version" in the new version;
  - `holochain/client.ts`, calls to the `previous` role.
- Tests:
  - `tests/tryorama/src/migration.test.ts`, two real networks end to end;
  - `issuer/test/service.test.ts`, the carry-over rules.
