# Local development

All commands run from `web/`.

This is the development setup: the UI in a browser, provisioning identities on a shared dev conductor. Production runs the UI inside a Holochain runtime instead; see [DEPLOYMENT.md](DEPLOYMENT.md).

Needs Holochain 0.7.1 (`holochain`, `hc`, `lair-keystore`, `kitsune2-bootstrap-srv`) on your `PATH`. The official release binaries work; the app uses no unstable Holochain features. The conductor, the HDK and HDI (`Cargo.toml`) and `@holochain/client` move together: a different Holochain patch release builds a different DNA, so mixing versions puts you on a different network.

Money: the dev conductor's DNA sets no `credit_limit_cents`, so every account may go $10,000 into debt and orders work without funding anyone. A production network sets the limit (0 recommended) and names issuers who fund accounts; see DEPLOYMENT.md and SECURITY.md.

Signing in, in dev: the browser remembers one identity on the dev node. **Profile → Switch to another identity** jumps to anyone on the node (the seeded people, or accounts you made). An account made through onboarding is behind a device passkey; reopening the app shows **Unlock Relay** and only prompts for Touch ID or Windows Hello when you tap it, since Safari refuses or stalls a prompt that fires on page load. After `npm run dev:reset`, an identity the browser remembers is gone: the app notices, forgets it, and asks you to sign in. If the connection to the node drops (a sleeping laptop, a background tab, a conductor restart), the app reconnects with a fresh token by itself and shows "Reconnecting to your node..." meanwhile.

The seed sets up a dev issuer, "Relay Credits (dev)": it writes the network's properties, naming that issuer, to `web/public/dev-network.json`, and every identity -- seeded, or created in the app's onboarding -- joins that network. Customers start with $100 added through it. Cash-outs wait until you approve or decline them with `npm run issuer`.

| Command | What it does |
| --- | --- |
| `npm run dev:conductor` | Starts the persistent dev conductor at `ws://localhost:8870`. Its data lives in `.dev/conductor/` and **survives restarts**. Logs: `.dev/conductor.log`. |
| `npm run dev` | Starts the UI. Onboarding is prefilled with the dev conductor's address, and lists every identity already on it under "Use an existing identity". |
| `npm run backend` | After any Rust change: builds the zomes, regenerates the TS wire types, packs the DNA and hApp, publishes the bundle to `web/public/relay.happ`, and updates the running conductor (see below). |
| `npm run typegen` | Regenerates `src/holochain/generated.ts` from the Rust types (`tools/typegen`). `npm run backend` runs it for you; CI fails if it's stale. |
| `npm run seed` | Creates a demo world on an empty conductor: three stores (two with the same owner), a driver, customers, and orders in every state. `-- --at lat,lon` seeds around any location. |
| `npm run dev:reset` | Wipes all dev data, restarts the conductor on the current build, and seeds it. |
| `npm start` in `issuer/` | The real issuer service against Stripe's test mode: card top-ups and bank payouts for the dev issuer. Setup in `issuer/README.md`. |
| `npm run issuer` | The dev network's issuer ("Relay Credits (dev)"), from the terminal: lists cash-outs waiting; `-- pay 1` (or `pay all`), `-- decline 1 "reason"`, and `-- grant "Sam Patel" 25` to add funds. |
| `npm run package -- --network-seed <name>` | Builds the production `deploy/relay.webhapp` for a network -- see [DEPLOYMENT.md](DEPLOYMENT.md). |

## What `npm run backend` does to a running conductor

It compares the freshly packed DNA's hash with the DNA each installed identity runs:

- **Same DNA** — only coordinator code changed. The new coordinators are hot-swapped into every identity: no restart, no data loss, no page reload.
- **Different DNA** — an integrity zome (entry/link types, validation) or a DNA setting changed. Existing identities can't run the new build; it tells you so. Run `npm run dev:reset`.

## Who signs each step of an order

Validation decides who may author each status change (`transition_requirement` in `dispatch_types`), so a modified client can't skip a step that isn't its own:

- **The customer** places the order, accepts a driver's bid, and confirms it arrived.
- **The store** accepts or declines the order, confirms it's preparing it, and marks a pickup ready. A delivery reaches drivers only once the store accepts it (`Placed → Open`), so a declined order never costs a driver a trip.
- **The driver** reports heading to the store and the pickup.

A store has a **response window** to accept a new order: the DNA property `store_response_secs`, default 5 minutes. Validation refuses an acceptance after it. Every cancellation records why (`Cancellation`: by the customer, by the store with a `DeclineReason`, the store didn't respond, or an arbitrator's ruling), and validation checks the reason against its author. Only the customer can say the store didn't respond, and only once the window has passed.

Some of this runs on people's own conductors through Holochain's scheduler, with no app open (`dispatch::upkeep`):

- The **customer's** conductor places a scheduled order with its store when it's due, and cancels any order its store didn't answer in time.
- A **store's** conductor, if the store has `auto_accept_orders` on, accepts new orders as they arrive and declines any priced from an outdated menu. Goodie-bag orders are always accepted, since the store already confirmed the claim.

Each job runs right after the event that triggers it (placing an order, or the store's `OrderPlaced` signal), and from a once-a-minute sweep for anything a missed signal or a restart left behind.

Accepting is also the store's price check (`ensure_priced_from_current_menu`). Validation recomputes every total but sees records as they were, so it can't tell an item's old price from its current one. The store's conductor can: it reads its menu's history from its own source chain, which holds every version it wrote and so can't lag behind (a DHT read can). It refuses a line priced from an outdated version, except an order placed in the 15 minutes before that item's price changed, which an honest customer could have raced. Since nothing completes or gets paid without the store's acceptance, an underpriced order can exist but never goes anywhere.

## Personal data

Every entry on the DHT is readable by every peer, forever. So anything personal is stored **sealed**: encrypted with `relay_coordinator_support::seal` (libsodium box between two agents' own keys; no key exchange needed) and opened with `open`. Box is symmetric, so whoever seals can always re-open, and sealing to yourself keeps a value private to you.

| Data | Readable by |
| --- | --- |
| A delivery's exact drop-off and drop-off notes | the customer; the driver, once their bid is accepted |
| An order's note for the kitchen | the customer and the store |
| A customer's name | the customer; the store of each of their orders; its driver, once assigned |
| Saved addresses, recurring orders, a delivery claim's drop-off, a profile's phone | their owner |

**Customers are pseudonymous.** A customer publishes no name: their profile holds it sealed, and each order carries it sealed to the store (and, inside the drop-off, to the driver). Someone reading the DHT sees an agent key place an order with a store, and nothing that names the person behind it. A store's and a driver's names are public, as their business.

Public on purpose: a delivery's drop-off *area* (a ~1.2 km geohash cell, for driver discovery), a store's own address and phone, a store's and driver's names.

Not hidden, and why:
- **Which key orders from which store.** Every action's author is public on a DHT, and so is each payment's payer and payee. Hiding the link itself would need a different ledger and authorship model. What's hidden is who the key is.
- **A key's own history.** One key's orders are linkable to each other.
- **Someone who's also a store or a driver.** They have one key and a public name, so their orders are attributable. A person who wants to order privately should use a separate identity for it.

Validation can't read sealed fields, so rules that need them (the delivery radius) run in the coordinator. Validation can't read sealed fields, so rules that need them (the delivery radius) run in the coordinator. A new field holding personal data should be sealed the same way; `privacy.test.ts` checks the published bytes.

## Tests

**Backend (Tryorama)** -- `cd tests/tryorama && npm test` runs every `src/*.test.ts` against `workdir/relay.happ` (which `npm run backend` keeps current), one file at a time. `node run.mjs reviews chat` runs just those files. Each file's output goes to `tests/tryorama/.logs/`; a failure is retried once and reported as flaky if it then passes. `link-validation` needs the test-only coordinators first: `npm run build:test-coordinators`.

**Browser smoke tests (Playwright)** -- `npm run test:e2e` (from `web/`) signs in as the seeded people and walks each role's main screens against the dev conductor, so run `npm run dev:reset` first. They add an order or two to the seeded world.

**Unit tests** -- `npm test` (from `web/`) for the UI's pure logic (`web/test/`); `cargo test --workspace --lib` from the repo root for Rust.

CI (`.github/workflows/ci.yml`) runs all of these, plus the zome build, the generated-types check, and the web typecheck, lint and build.

Ports can be changed with `RELAY_ADMIN_PORT` / `RELAY_BOOTSTRAP_PORT` (and `VITE_RELAY_ADMIN_URL` for the UI's default).
