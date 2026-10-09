# Deploying Relay

Relay has no application servers. Every customer, store and driver runs their own Holochain conductor inside the Relay app, which keeps their keys and data on their own device. A network needs only two small pieces of shared infrastructure: a **bootstrap server** (how peers find each other) and a **relay server** (how peers behind NATs reach each other).

## How the app runs in production

The UI ships inside a Holochain runtime that hosts it:

- a desktop or mobile build with the Tauri plugin (`tauri-plugin-holochain`), or
- a launcher that installs a `.webhapp` (Kangaroo for desktop installers, or the Holochain Launcher).

The runtime runs the conductor, installs the hApp for its one agent, hands the UI that app, and signs every zome call itself. The UI speaks only the App API (`AppWebsocket.connect()` with no arguments, in `web/src/holochain/client.ts`); it never touches the Admin API or a private key.

Development is different on purpose. `npm run dev` runs the UI in a browser against the dev conductor and provisions identities through its Admin API, so several people can share one node (`web/src/holochain/devHost.ts`). That code is compiled out of every production build: `__DEV_HOST__` is a build-time literal (`web/vite.config.ts`), and a production bundle contains no Admin API calls. A production build opened in a plain browser shows "Open Relay in the Relay app" and does nothing else.

**Any release runtime works.** The hApp uses no unstable Holochain features, so it runs on the official 0.7 binaries a runtime downloads. Delivery handoffs are two plain entries (the driver's record, the other party's acknowledgment), not a countersigned one; countersigning is still unstable and no release build ships it. It's worth revisiting for ledger transfers, where both balances must move atomically, once it's stable.

## 1. Decide the network

These values are part of the DNA hash. Everyone on a network must install a bundle built with exactly the same values; a different value is a separate network that can't see this one.

- **Network seed.** A name for the network, such as `relay-2026`. Change it to start a fresh network.
- **Arbitrators** (`arbitrators`). The agent keys allowed to rule on disputes. Without at least one, no dispute can be resolved, and packaging refuses to run. Because the roster is fixed in the DNA, the keys must exist before the bundle does. Arbitrators should run a conductor you operate, with keys generated in its keystore ahead of time, and install the bundle with those keys. Changing the roster later means shipping a new DNA (see Upgrades).
- **Store response window** (`store_response_secs`, default 300). How long a store has to accept an order before the customer's conductor cancels it.
- **Credit limit** (`credit_limit_cents`, required). How far below zero any balance may go. Use 0: every order is then paid from money already in the account, so a fresh identity can't order on credit and walk away. Packaging refuses to run without it.
- **Confirmation window** (`confirm_window_secs`, default 86400). How long a customer has to confirm a delivery or report a problem once the driver records it (an hour at most when the PIN was collected). After that, the driver's app raises it with the arbitrators. Arbitrators should run a conductor that's always online: it rules the clear cases (a matching PIN; an unconfirmed, photographed drop-off) every five minutes, and leaves the rest for a person on the arbitrator screen.
- **Issue window** (`issue_window_secs`, default 7200). How long a customer has, once an order is confirmed, to report missing or wrong items. The store's payment for the food is held until it closes; the driver is paid at once. Each order's window is kept by one arbitrator (chosen from the order's hash), whose conductor opens and closes it on its own clock every five minutes. The store has the final say on each report: those it accepts or never answers are refunded at the close, those it declines aren't. Nobody needs to review them. A network with no arbitrators has no window, and the store is paid on the customer's receipt.
- **Issuers** (`issuers`). The agent keys allowed to put money into the network: the stand-in for a payment processor crediting an account against a real card payment. With a credit limit of 0, nobody can pay for anything until an issuer credits them, so packaging requires at least one. Like arbitrators, they need keys generated on a conductor you operate before the bundle is built. An issuer calls `ledger::issue_grant` once a payment clears; the recipient's app collects it.

Copy `deploy/properties.example.json` to `deploy/properties.json` (gitignored) and fill it in.

## 2. Run the network's servers

Run `kitsune2-bootstrap-srv` (from the same Holochain release CI pins, with its checksum: `.github/actions/holochain-bins/action.yml`) behind TLS. It serves both bootstrap and relay. Note its public URLs.

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

## Notifications

Each order change is signalled straight to the order's other parties, conductor to conductor, and the app turns that into a system notification (Profile → Notifications), plus a chime on a store's device for each new order. This works while the app is running, in front or in the background; Kangaroo's Electron shell shows web notifications natively, and a Tauri build needs its notification plugin allowed. A fully quit app receives nothing until it's opened again, when its screens catch up. Notifying a phone whose app is closed needs a push relay (APNs/FCM), which means running a server that learns who to wake; that's a deliberate later decision, not something the network needs to work.

## Upgrades

- **Coordinator-only changes** (no change to entry types, link types or validation) keep the DNA hash. Ship a new app version and the network carries on.
- **Integrity changes** produce a new DNA, which is a new network. Plan them as migrations: ship a version that joins the new network, and move what has to carry over, such as profiles and store menus, with the app's help.
