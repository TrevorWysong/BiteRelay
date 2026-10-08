# Local development

All commands run from `web/`.

| Command | What it does |
| --- | --- |
| `npm run dev:conductor` | Starts the persistent dev conductor at `ws://localhost:8870`. Its data lives in `.dev/conductor/` and **survives restarts**. Logs: `.dev/conductor.log`. |
| `npm run dev` | Starts the UI. Onboarding is prefilled with the dev conductor's address, and lists every identity already on it under "Use an existing identity". |
| `npm run backend` | After any Rust change: builds the zomes, regenerates the TS wire types, packs the DNA and hApp, publishes the bundle to `web/public/relay.happ`, and updates the running conductor (see below). |
| `npm run typegen` | Regenerates `src/holochain/generated.ts` from the Rust types (`tools/typegen`). `npm run backend` runs it for you; CI fails if it's stale. |
| `npm run seed` | Creates a demo world on an empty conductor: three stores (two with the same owner), a driver, customers, and orders in every state. `-- --at lat,lon` seeds around any location. |
| `npm run dev:reset` | Wipes all dev data, restarts the conductor on the current build, and seeds it. |

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
| Saved addresses, recurring orders, a delivery claim's drop-off, a profile's phone | their owner |

Public on purpose: a delivery's drop-off *area* (a ~1.2 km geohash cell, for driver discovery), a store's own address and phone. Not hidden: who orders from which store, since an order names both. Validation can't read sealed fields, so rules that need them (the delivery radius) run in the coordinator. A new field holding personal data should be sealed the same way; `privacy.test.ts` checks the published bytes.

## Tests

**Backend (Tryorama)** -- `cd tests/tryorama && npm test` runs every `src/*.test.ts` against `workdir/relay.happ` (which `npm run backend` keeps current), one file at a time. `node run.mjs reviews chat` runs just those files. Each file's output goes to `tests/tryorama/.logs/`; a failure is retried once and reported as flaky if it then passes. `link-validation` needs the test-only coordinators first: `npm run build:test-coordinators`.

**Browser smoke tests (Playwright)** -- `npm run test:e2e` (from `web/`) signs in as the seeded people and walks each role's main screens against the dev conductor, so run `npm run dev:reset` first. They add an order or two to the seeded world.

**Unit tests** -- `npm test` (from `web/`) for the UI's pure logic (`web/test/`); `cargo test --workspace --lib` from the repo root for Rust.

CI (`.github/workflows/ci.yml`) runs all of these, plus the zome build, the generated-types check, and the web typecheck, lint and build.

Ports can be changed with `RELAY_ADMIN_PORT` / `RELAY_BOOTSTRAP_PORT` (and `VITE_RELAY_ADMIN_URL` for the UI's default).
