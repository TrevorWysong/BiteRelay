# Relay

A food delivery marketplace with no company in the middle, built on [Holochain](https://www.holochain.org). Customers order from local stores, drivers bid to carry the orders, and money is held and settled by rules every peer checks: there's no app server to trust, take a cut, or go down.

Each customer, store and driver runs their own Holochain node inside the Relay app. Orders, menus, bids, handoffs and payments are entries on their authors' own chains, shared on a DHT, and every rule that matters (pricing, who may change an order, who is owed what, deadlines) is enforced by validation that every peer runs. A network's few servers -- a bootstrap and relay server, an issuer that turns card payments into credits and back, and optionally a push relay -- help people find each other and move money in and out; none of them can change an order or a balance.

## Where things are

| Path | What it is |
| --- | --- |
| `dnas/relay/` | The hApp's one DNA: its rules and its API. |
| `dnas/relay/zomes/` | One zome per concern, each an **integrity** crate (entry and link types, and validation) and a **coordinator** crate (the functions the app calls): `profiles` (people and their addresses), `catalog` (stores, menus, promos, goodie bags), `dispatch` (orders from checkout to settlement, drivers, bids), `attestation` (handoffs), `ledger` (money held and settled), `reputation` (ratings), `account` (recovery, moving phones, moving networks). |
| `dnas/relay/governance/` | The network's settings, read from the DNA's properties: currency, deadlines, limits, issuers, services. |
| `dnas/relay/integrity_support/`, `coordinator_support/` | Building blocks shared by every integrity zome and every coordinator zome. |
| `dnas/relay/types/` | Types shared across zomes. |
| `web/` | The app: React and TypeScript, speaking only the conductor's App API. `src/routes/` has the customer, store and driver screens; `src/holochain/` the connection and one wrapper per zome; `src/lib/` the app's logic; `src/i18n/` its languages. `scripts/` runs the dev network and packaging. |
| `tests/tryorama/` | The integration suite: real conductors running the real hApp, one scenario per file. |
| `issuer/` | The issuer service: card top-ups and bank payouts through Stripe. |
| `push/` | The push relay: wakes a closed app without learning who asked or about what. |
| `runtime/device/` | What a Relay runtime does natively, which the UI can't: moving an account's key to a new phone. |
| `deploy/` | Running a network's servers (Docker Compose, Caddy) and the bundles a network ships. |
| `tools/typegen/` | Generates the app's TypeScript types from the Rust ones, so the two can't drift. |
| `docs/` | How it works, how to run it, and the plans (below). |

## Getting started

You need Holochain 0.7.1's binaries (`holochain`, `hc`, `lair-keystore`, `kitsune2-bootstrap-srv`) on your `PATH`, Rust with the `wasm32-unknown-unknown` target, and Node 24.

```sh
cd web
npm install
npm run backend      # build the zomes and pack the hApp
npm run dev:reset    # a fresh dev conductor, seeded with stores, people and orders
npm run dev          # the app, at http://localhost:5173
```

Sign in as anyone the seed made from the onboarding screen's "Use an existing identity". [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) has every command, the tests, and the rules for writing zome code.

## Docs

**Running it**
- [DEVELOPMENT](docs/DEVELOPMENT.md) -- the dev network, commands, tests, and how zome code is written here.
- [DEPLOYMENT](docs/DEPLOYMENT.md) -- deciding a network's settings, running its servers, packaging and shipping the app.
- [MIGRATION](docs/MIGRATION.md) -- shipping a change to the rules: moving everyone to a new network.
- [MOBILE](docs/MOBILE.md) -- what phones change, and waking a closed app.

**How it works**
- [SECURITY](docs/SECURITY.md) -- the threat model, what validation guarantees, and what it can't.
- [RECOVERY](docs/RECOVERY.md) -- keeping an account across phones, and getting it back after losing one.
- [I18N](docs/I18N.md) -- the app's languages.
- [HOLOCHAIN_ISSUES](docs/HOLOCHAIN_ISSUES.md) -- what we've found in Holochain itself, the workarounds, and what the next upgrade changes.

**Plans** (research and designs, some built)
- [CARD_PAYMENTS](docs/CARD_PAYMENTS.md) -- paying by card, and getting money out.
- [PAYMENT_RAILS](docs/PAYMENT_RAILS.md) -- cards and HoloFuel side by side.
- [MENU_CUSTOMIZATION](docs/MENU_CUSTOMIZATION.md) -- sizes, add-ons and choices.
- [SALES_TAX](docs/SALES_TAX.md) -- tax on food, fees and tips.
- [TAX_REPORTING](docs/TAX_REPORTING.md) -- what each party needs at tax time.
