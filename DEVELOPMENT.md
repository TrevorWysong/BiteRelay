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

## Tests

**Backend (Tryorama)** -- `cd tests/tryorama && npm test` runs every `src/*.test.ts` against `workdir/relay.happ` (which `npm run backend` keeps current), one file at a time. `node run.mjs reviews chat` runs just those files. Each file's output goes to `tests/tryorama/.logs/`; a failure is retried once and reported as flaky if it then passes. `link-validation` needs the test-only coordinators first: `npm run build:test-coordinators`.

**Browser smoke tests (Playwright)** -- `npm run test:e2e` (from `web/`) signs in as the seeded people and walks each role's main screens against the dev conductor, so run `npm run dev:reset` first. They add an order or two to the seeded world.

**Unit tests** -- `npm test` (from `web/`) for the UI's pure logic (`web/test/`); `cargo test --workspace --lib` from the repo root for Rust.

CI (`.github/workflows/ci.yml`) runs all of these, plus the zome build, the generated-types check, and the web typecheck, lint and build.

Ports can be changed with `RELAY_ADMIN_PORT` / `RELAY_BOOTSTRAP_PORT` (and `VITE_RELAY_ADMIN_URL` for the UI's default).
