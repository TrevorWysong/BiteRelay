# Deploying Relay

Relay has no application servers. Every customer, store and driver runs their own Holochain conductor inside the Relay app, which keeps their keys and data on their own device. A network needs only two small pieces of shared infrastructure: a **bootstrap server** (how peers find each other) and a **relay server** (how peers behind NATs reach each other).

## How the app runs in production

The UI ships inside a Holochain runtime that hosts it:

- a desktop or mobile build with the Tauri plugin (`tauri-plugin-holochain`), or
- a launcher that installs a `.webhapp` (Kangaroo for desktop installers, or the Holochain Launcher).

The runtime runs the conductor, installs the hApp for its one agent, hands the UI that app, and signs every zome call itself. The UI speaks only the App API (`AppWebsocket.connect()` with no arguments, in `web/src/holochain/client.ts`); it never touches the Admin API or a private key.

Development is different on purpose. `npm run dev` runs the UI in a browser against the dev conductor and provisions identities through its Admin API, so several people can share one node (`web/src/holochain/devHost.ts`). That code is compiled out of every production build: `__DEV_HOST__` is a build-time literal (`web/vite.config.ts`), and a production bundle contains no Admin API calls. A production build opened in a plain browser shows "Open Relay in the Relay app" and does nothing else.

**The runtime's conductor must support countersigning.** Delivery receipts use Holochain's countersigning, which 0.7 builds only with the `unstable-countersigning` feature. A runtime whose conductor lacks it can't load the hApp (`unknown import "__hc__accept_countersigning_preflight_request_1"`). Check this first when choosing or building a runtime: build its Holochain with that feature if it bundles its own.

## 1. Decide the network

These values are part of the DNA hash. Everyone on a network must install a bundle built with exactly the same values; a different value is a separate network that can't see this one.

- **Network seed.** A name for the network, such as `relay-2026`. Change it to start a fresh network.
- **Arbitrators** (`arbitrators`). The agent keys allowed to rule on disputes. Without at least one, no dispute can be resolved, and packaging refuses to run. Because the roster is fixed in the DNA, the keys must exist before the bundle does. Arbitrators should run a conductor you operate, with keys generated in its keystore ahead of time, and install the bundle with those keys. Changing the roster later means shipping a new DNA (see Upgrades).
- **Store response window** (`store_response_secs`, default 300). How long a store has to accept an order before the customer's conductor cancels it.
- **Ledger settling window** (`ledger_settle_secs`, default 3600). How old a payment must be before a balance checkpoint may cover it. It should comfortably exceed how long gossip takes on your network.

Copy `deploy/properties.example.json` to `deploy/properties.json` (gitignored) and fill it in.

## 2. Run the network's servers

Run `kitsune2-bootstrap-srv` (the same version CI installs; see `.github/workflows/ci.yml`) behind TLS. It serves both bootstrap and relay. Note its public URLs.

## 3. Package

```sh
cd web
npm run package -- --network-seed relay-2026 \
  --bootstrap-url https://bootstrap.example.org --relay-url https://relay.example.org
```

This builds the zomes and the production UI and writes `deploy/relay.webhapp`: the hApp with your properties, seed and server URLs, plus the UI. Every installer of your network uses this one file.

## 4. Ship it

- **Desktop installers:** [Kangaroo](https://github.com/holochain/kangaroo-electron). Put `relay.webhapp` in its `pouch/`, set the app id, name and version in `kangaroo.config.ts`, and build signed installers for macOS, Windows and Linux. Kangaroo runs the conductor and keystore and handles auto-updates.
- **Desktop and mobile from one codebase:** a Tauri app with `tauri-plugin-holochain`. It embeds the conductor and serves this same UI; `@holochain/client` detects the Tauri runtime on its own, so the UI needs no changes.
- **Holochain Launcher:** users can install `relay.webhapp` directly.

## Running it

Some of Relay's work happens on people's own conductors through Holochain's scheduler, without the UI open (`dispatch::upkeep`, `dispatch::settlement`). It only happens while the app is running:

- **Stores** should keep the app running while they're open, the way a store keeps its order tablet on. Their conductor accepts orders automatically (if auto-accept is on) and pays its share of delivery fees. A store whose app is closed doesn't answer orders; once the response window passes, validation won't let it accept them.
- **Customers'** conductors place scheduled orders when they're due and cancel orders a store never answered. If a customer's app is closed, this happens the next time it runs. Their unanswered orders can't be accepted in the meantime either.

## Upgrades

- **Coordinator-only changes** (no change to entry types, link types or validation) keep the DNA hash. Ship a new app version and the network carries on.
- **Integrity changes** produce a new DNA, which is a new network. Plan them as migrations: ship a version that joins the new network, and move what has to carry over, such as profiles and store menus, with the app's help.
