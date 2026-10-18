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
- **Store response window** (`store_response_secs`, default 300). How long a store has to accept an order before the customer's conductor cancels it.
- **Credit limit** (`credit_limit_cents`, required). How far below zero any balance may go. Use 0: every order is then paid from money already in the account, so a fresh identity can't order -- or post a driver's collateral -- on credit and walk away. Packaging refuses to run without it, and refuses anything above 0 unless built with `RELAY_ALLOW_CREDIT=1`.
- **Report window** (`report_window_secs`, default 7200). How long a customer has, once they have their order, to report missing or wrong items. The store's payment for the food waits until it ends; the driver is paid as soon as the store's app records the delivery. The store has the final say on each report: its app refunds those it accepts or never answers and settles the rest. Nobody else reviews them.
- **Issuers** (`issuers`). The agent keys allowed to put money into the network: the stand-in for a payment processor crediting an account against a real card payment. With a credit limit of 0, nobody can pay for anything until an issuer credits them, so packaging requires at least one. They need keys generated on a conductor you operate before the bundle is built. An issuer calls `ledger::issue_grant` once a payment clears; the recipient's app collects it.

Every other setting is optional, and the defaults suit most networks. Set only the ones you change:

| Setting | Default | What it governs |
| --- | --- | --- |
| `currency` | `"USD"` | The ISO 4217 currency every amount is in, in its minor units. Display only: the ledger is unit-agnostic. |
| `answer_grace_secs` | 1800 | However late a report of missing items comes, the store has at least this long to answer it (never longer than the report window). |
| `claim_grace_secs` | 1800 | How long a customer's "never arrived" stands before the store's app decides it. The store can decide sooner. |
| `max_code_attempts` | 5 | Wrong handoff codes a giver's app answers for one order before it stops. |
| `default_prep_minutes` | 15 | A new store's usual prep time. |
| `max_prep_minutes` | 240 | The longest a store may say an order will take. |
| `default_delivery_radius_km` | 8 | A new store's delivery radius. |
| `max_delivery_radius_km` | 50 | The furthest any store may deliver. Validation checks every order's drop-off area against its store's radius. |
| `default_delivery_subsidy_percent` | 50 | A new store's share of each delivery fee. |
| `suggested_delivery_fees` | `[400, 600, 900, 1200]` | The delivery fee caps checkout suggests, in minor units of `currency`. Set them with the currency. |
| `store_listing_stake` | 2000 | What listing a store for customers to find sets aside from its owner's balance, in minor units -- returned when the listing closes. Every listing is backed by money while it stands, so nobody can fill a neighbourhood with fake stores. With a credit limit of 0, a store needs funds before it can list. |
| `max_pending_orders` | 5 | The most orders a customer may place within one store response window. An order costs nothing until a store accepts it, so this keeps one identity from burying a store's queue. |
| `default_bag_hold_minutes` | 30 | How long a new goodie bag holds a confirmed claim for its customer to order, unless the store sets its own. |
| `offer_secs` | 45 | How long a driver whose bid is accepted has to commit (set aside their collateral) before the store's app offers the order to another. |
| `pickup_grace_secs` | 900 | How long past when a committed driver is due at the store (its ready time, or as soon as they could arrive from when it confirmed them) before the store's app moves them on and the customer may collect it themselves. A driver may drop an order any time before pickup. |
| `store_wait_secs` | 900 | How long a checked-in driver waits past the store's ready time before they may call it late, for a store that hasn't set its own (`store_wait_minutes`, part of each order's terms). Late, the driver leaves paid in full by the store, the order goes to another driver, and the customer may cancel for a full refund. |
| `min_store_wait_secs` | 300 | The shortest wait a store may set. |
| `max_store_wait_secs` | 2700 | The longest wait a store may set. |
| `replacement_window_secs` | 900 | How long an order a driver left after the store started cooking stays open to another driver before the store's app ends it: the customer is refunded and that driver's collateral pays for the food. |
| `max_driver_changes` | 6 | How many times an order may change drivers (each one leaving or moved on). Past it, the order can only be collected or cancelled -- which bounds the history validation walks. |
| `max_offers_per_order` | 20 | How many bids an order's customer may accept in all, counting offers drivers let lapse -- so a ring of throwaway drivers can't exhaust an order, and its history stays bounded. |
| `max_ranked_bids` | 30 | How many of an order's bids its customer's app weighs, earliest first, so a flood of bids can't slow matching. |
| `min_reporter_stores` | 3 | How many different stores a driver must have completed deliveries for before their report that a store wouldn't check them in counts on the store's record. |
| `bid_window_secs` | 30 | How long a customer's app collects bids, from the first, before matching automatically. |
| `minute_value_cents` | 10 | What each minute of a bid's ETA counts for in the published matching rule, in minor units. |
| `services` | OpenStreetMap's public servers | The map tiles and address search the app uses: `{ map_tiles_url, map_attribution, geocoder_url }`. The tile URL is a `{z}/{x}/{y}` template; the geocoder is a Nominatim-compatible API (your own Nominatim, or Photon). **Set it for production**: OpenStreetMap's public servers don't allow an app's production traffic, and every lookup tells them where someone is. Packaging warns when it's unset. Never consulted by validation. |
| `time_source` | drand quicknet | The public time source deadline claims are proved against: `{ public_key (hex, BLS G2), genesis_secs, period_secs, relays, chain_hash }`. Validation checks a round's signature against the key alone; apps fetch rounds from the relays. |
| `collection_window_secs` | 3600 | How long a customer collecting a delivery themselves has to come for it, before the store may record it uncollected and keep the food's price. |
| `max_concurrent_deliveries` | 3 | The most orders a driver may carry at once. Validation refuses a pickup past it, and a priority order is always carried alone. |
| `add_on_detour_km` | 2 | While delivering, a driver is offered only orders from a store they're still to collect from, or going within this distance of one of their drop-offs. |
| `max_image_bytes` | 300000 | The largest photo, in bytes of its data URI. Every peer that stores an entry stores its photos. |
| `goodie_bag_max_days` | 7 | The longest a goodie bag may stay listed. |
| `clock_tolerance_secs` | 600 | How far an author's clock may be from a time it claims, where a rule compares them. |
| `price_change_grace_secs` | 900 | How long after a price changes a store still accepts an order priced from the old one. |

The app reads these from the network itself (`get_network_terms`), so its screens and its policies page always quote what's enforced.

Copy `deploy/properties.example.json` to `deploy/properties.json` (gitignored) and fill it in.

## 2. Run the network's servers

A network needs three things running on machines you control. Each is small:

1. **Bootstrap and relay** (`kitsune2-bootstrap-srv`) behind TLS. Peers find each other through it, and reach each other through it when NATs are in the way. Holochain refuses a plaintext relay outside development.
2. **The issuer's conductor**: an always-on Holochain node holding the issuer's agent key, on the same network as everyone else (`issuer/scripts/conductor.mjs`). Its admin interface listens on its own machine only.
3. **The issuer service** (`issuer/`, see its README): card top-ups, payout accounts, cash-outs, recoveries. It runs beside the issuer's conductor, and it's the only thing that talks to it. It's reached by the app over https: its address is published in the issuer's profile.

The issuer's key has to be on the network's roster (`issuers` in `deploy/properties.json`), which is part of the DNA. So the order is:

```sh
# On the issuer's machine (ISSUER_DATA_DIR short: the keystore's socket path is limited).
export ISSUER_DATA_DIR=/var/lib/relay-issuer ISSUER_LAIR_PASSPHRASE=... \
       BOOTSTRAP_URL=https://bootstrap.example.org RELAY_URL=https://bootstrap.example.org
node issuer/scripts/conductor.mjs &          # the issuer's node
node issuer/scripts/provision.mjs key        # prints its key: add it to deploy/properties.json `issuers`

# Anywhere: build the network's bundle with that roster (step 3 below) -> deploy/relay.happ and relay.webhapp

# Back on the issuer's machine:
node issuer/scripts/provision.mjs install deploy/relay.happ   # same bundle as everyone
cd issuer && npm start                       # the service (issuer/.env, see .env.example)
```

**Keep safe:**
- `ISSUER_DATA_DIR` holds the issuer's key and chain: back it up. Losing it means losing the ability to grant and pay out.
- The passphrase unlocks the keystore. Keep it in a secret store.

**Stripe** (the issuer README has the details):
- live keys only once the issuer is cleared to handle real money (`ALLOW_LIVE_STRIPE=1`);
- a webhook endpoint at `https://<issuer>/webhooks/stripe` with the events `checkout.session.completed`, `charge.dispute.created` and `charge.dispute.closed`;
- Radar rules.

### With Docker Compose

`deploy/docker-compose.yml` runs all three behind Caddy, which fetches TLS certificates itself:
- `deploy/issuer/Dockerfile` builds one image: the pinned Holochain binaries, checked against CI's hashes, and the issuer;
- `deploy/issuer/start.sh` starts the conductor, then prints the key (`key`) or installs the hApp and serves (`serve`).

```sh
cd deploy
cp ../issuer/.env.example issuer.env       # fill in; never commit it (gitignored)
export BOOTSTRAP_DOMAIN=bootstrap.example.org ISSUER_DOMAIN=issuer.example.org
docker compose run --rm issuer key         # the issuer's key, for the roster
#   ...package the network with it, so deploy/relay.happ exists...
docker compose up -d --build
```

The scripts it runs are tested (a fresh conductor, key, install, admin on localhost only). **The images and Compose file themselves haven't been run yet**: build them once on the target machine and check the logs before relying on them.

### Apple Pay and Google Pay

The card form is Stripe's own (Embedded Checkout). It offers Apple Pay and Google Pay only:
- in a browser engine that supports them;
- on a domain registered in Stripe (Settings → Payment methods).

Inside the desktop app (Kangaroo's Electron), they don't appear, and cards still work. In a Tauri mobile build, test them on the device before promising them.

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
- **Integrity changes** produce a new DNA, which is a new network. People move their accounts to it: balances (carried by the issuer), profiles, stores and history. MIGRATION.md has the protocol and the operator's steps.
