# Relay on phones

What running Relay on a phone takes, what it changes, and how a closed app still gets woken for an order. This is a design and spike plan. The phone builds themselves need Xcode and the Android SDK, which the development machine doesn't have yet (see "Running the spike").

## The build

The UI needs no changes. It speaks only the App API, and `@holochain/client` detects a Tauri runtime on its own (`web/src/holochain/host.ts`). A phone build is a Tauri 2 app with `tauri-plugin-holochain`, from the Holochain ecosystem's p2p-shipyard tooling. It embeds the conductor and keystore in the app, installs `relay.happ` for the phone's one agent, and serves this same UI.

Check these against the plugin's current release before committing to dates:

- **Android** is the plugin's best-supported mobile target. The conductor runs in-process, and zome WASM compiles on the device.
- **iOS forbids JIT compilation.** Holochain's default WASM engine compiles at runtime, so iOS needs an interpreter build. Holochain has been adding one (a `wasmer_wamr` feature); confirm it ships in the 0.7 line the plugin uses.
  - Interpreted zomes are slower. Relay's validation walks chains and recomputes prices, so measure a busy store's validation on an older iPhone before launch.
- **Size:** the conductor adds tens of megabytes to the app. That's fine for stores, but worth measuring against people's tolerance for a food app's download.

## What a phone changes: the conductor sleeps

On a desktop the conductor runs while the app is open, and Relay's duties run then: the store's app settles orders, the customer's redeems claimed bags, the driver's picks up. A phone suspends apps in the background:

- **Android** keeps a conductor running only as a *foreground service*, with a persistent notification ("Relay is online"). It's right for drivers on shift and stores during opening hours. It's wrong for customers: nobody wants a permanent notification for a food app.
- **iOS** gives no equivalent. A backgrounded app is suspended within seconds (minutes at best, with background tasks), so a conductor on iOS is effectively up only while the app is open.

### Who needs to be awake, and when

| Role | Needs | How |
|---|---|---|
| Store | Online for its whole open hours: orders arrive, the response window runs (`store_response_secs`), and it hands over to drivers. | A tablet or phone kept open at the counter, which is how stores run delivery apps today. On Android, a foreground service while "Open" is on. |
| Driver | Online while on shift: offers, pickups, handoffs. | Android foreground service while "On shift". On iOS the app stays in front while driving, with navigation beside it. |
| Customer | Only at the moments their order moves: accepted, picked up, arriving, a question from the store. | **Woken by push** (below). The conductor catches up on waking, and every screen already reads fresh state when it opens. |

### Deadlines when a phone is asleep

Every deadline the network enforces is proved with drand time and validated, so a sleeping phone never makes anything *invalid*. At worst it makes something *late*:

- A customer's report window, claims and appeals wait for them. Nothing is lost by opening the app later.
- Automatic steps that run on the customer's conductor (redeeming a confirmed bag claim, settling their side) happen when they next open the app or are woken.
- A store's response window and a driver's offers are the time-critical ones. That's why stores and drivers run in the foreground.

## Waking a closed app: a push relay that learns nothing

To notify a phone whose app is closed, the phone has to be woken through Apple's (APNs) or Google's (FCM) push service. That needs a server holding the device's push token. A naive relay would learn the whole social graph: who orders from which store, when, and where drivers are. Relay's design keeps that server blind.

**Sealed wake tokens.**
1. The phone registers once with the network's push relay (`services.push_relay_url`, a network setting like the map services). It sends its APNs/FCM token and gets back a *device id* only the relay knows.
2. For each order, the phone mints a fresh **wake token**: its device id, encrypted to the relay's public key with a random nonce. Two tokens from the same phone look unrelated, so nobody holding them can tell they're the same person.
3. The wake token travels inside the order, sealed to the parties who should be able to wake this person, in the same way the drop-off address is shared with a committed driver. A store can wake its customer, and the customer's driver can wake them. Nobody else can even see the token.
4. To wake someone, a party's conductor posts the token to the relay. The relay decrypts it to a device and sends a **content-free** push: "something changed".
   - The push carries no order, name or amount, so Apple and Google learn only that the app was woken.
   - The phone wakes, its conductor syncs, and it shows a *local* notification built from what actually changed, in the person's language.

**What each party learns:**
- **The relay** learns that some device was woken at some time. It doesn't learn who asked, about what, or that two wakes concern the same order or person.
- **Apple and Google** learn that the app was woken.
- **Order parties** learn an opaque token that only works for that order's relay.

**Abuse:**
- The relay rate-limits per device: a few wakes a minute, a ceiling per day.
- Tokens carry an expiry inside the encryption, the order's lifetime plus its report window, so an old token is useless.
- A phone that's being spammed re-registers. That gets a new device id, and every outstanding token stops working.

**What it costs:** one small stateless service per network (device id → push token). It can be run by the network operator, the same party that runs the issuer, or anyone; a network can run more than one. A network without one still works: phones are notified while the app is open, which is today's behaviour.

### What changes in the hApp (not built yet)

- `services.push_relay_url` and the relay's public key, as network settings.
- A sealed `wake` field where order parties already exchange sealed details: the order (for its store), and the drop-off share (for its driver). The coordinator mints the token, and validation only bounds its size.
- The coordinator's signal fan-out (`signals.rs`), which already tells the order's other parties of each change, also posts their wake tokens to the relay. This happens from the sender's conductor, best-effort, and in its own call so a relay outage never fails an order step.

## Running the spike

On a machine with Xcode (for iOS) and Android Studio (SDK, NDK, and a JDK 17 or later; this one has JDK 16):

1. Scaffold a Tauri 2 app with the plugin (p2p-shipyard's `scaffold-tauri-happ`). Point it at `deploy/relay.happ` and serve `web/dist`.
2. `cargo tauri android dev` on a mid-range Android phone, then measure:
   - the conductor's startup time;
   - a store's validation time for a twenty-item order;
   - battery drain per hour as a foreground service, idle and during a lunch rush (`npm run dev:seed` traffic);
   - memory.
3. `cargo tauri ios dev` with the interpreter build, then measure the same, and how long iOS lets a backgrounded conductor finish a sync after a push.
4. Decide from the numbers. Proposed thresholds, to be checked against a real device:
   - foreground-service drain under about 5% an hour for drivers;
   - validation under a second for a typical order;
   - a sync within the background time iOS grants a push.

If iOS's numbers don't hold, a fallback keeps decentralization intact. Customers on iOS use a **light client** that keeps their own key and signs on the phone, but has a conductor they trust (their own desktop, or a community node) hold the chain while the phone sleeps. That's an architectural option, not built.
