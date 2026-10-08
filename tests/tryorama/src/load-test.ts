// A load-test harness, not a correctness test -- deliberately NOT part of
// `npm test`. Run directly (`npm run load-test`), tunable via env vars:
//   LOAD_CONDUCTORS=3 LOAD_AGENTS_PER_CONDUCTOR=12 npm run load-test
//
// Uses `installManyAgents` (helpers.ts) to put many real, independent
// agent-cells on a small number of conductor *processes* -- see that
// function's doc comment for why, and for the one real caveat (doesn't
// replicate true cross-machine gossip latency; does exercise real
// DHT/validation/storage/anchor-contention behavior).
//
// This exists specifically to close a gap named out loud after the
// scalability pass (architecture plan §9): every fix there was proven
// *correct* at 2-3 conductors, never proven *fast* or *genuinely
// concurrent* at real density. Three things this harness checks that the
// correctness suite didn't:
//   1. Presence-beacon write throughput and current-bucket read latency at
//      real agent counts, not 1-2 drivers.
//   2. The signal fan-out cap (MAX_SIGNAL_FANOUT=25), observed *live* by
//      counting how many of a real dense driver pool actually receive the
//      signal -- previously asserted only by a pure Vec::truncate unit
//      test, never watched happen against real conductors.
//   3. Ledger checkpoint correctness under *genuinely concurrent* writes
//      from many different authors to the same recipient -- the earlier
//      checkpoint.test.ts only ever drove transactions sequentially from
//      one payer, which can't surface a concurrent-write bug even if one
//      existed.
import assert from "node:assert/strict";
import os from "node:os";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { PlayerApp } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord, Signal } from "@holochain/client";
import { installManyAgents, actionHash, bytesEqual, decodeEntry, ST_PETE } from "./helpers.js";

const CONDUCTORS = parseInt(process.env.LOAD_CONDUCTORS ?? "3", 10);
const AGENTS_PER_CONDUCTOR = parseInt(process.env.LOAD_AGENTS_PER_CONDUCTOR ?? "12", 10);
const TOTAL_AGENTS = CONDUCTORS * AGENTS_PER_CONDUCTOR;
const MAX_SIGNAL_FANOUT = 25; // must match dispatch_coordinator::matching::MAX_SIGNAL_FANOUT
const SIGNAL_WAIT_MS = parseInt(process.env.LOAD_SIGNAL_WAIT_MS ?? "8000", 10);

// Architecture plan §10 follow-up: the earlier signal-reliability finding
// (3/35, 5/35, 2/7 delivered across three topologies) left one question
// explicitly undecided -- is that a real Iroh/Kitsune2 characteristic in
// this environment, or an artifact of many conductor processes sharing one
// machine's CPU? True disambiguation needs genuinely separate machines
// (not available here), but this is a real, direct test of the *contention*
// half of that question specifically: saturate every core with unrelated
// work throughout the run and see whether the signal-delivery rate gets
// meaningfully worse. `sudo`-requiring network-shaping (pfctl/dnctl WAN
// latency injection) was considered and set aside -- it needs an
// interactive password this environment can't supply, and Iroh's QUIC ports
// are OS-assigned ephemerally per conductor, so there's no fixed port to
// target rules at without first patching tryorama's own config generation.
// This is lower-friction and more directly targeted at the actual open
// question.
const STRESS_CPU = process.env.STRESS_CPU === "1" || process.env.STRESS_CPU === "true";

type Timing = { label: string; ms: number; opCount?: number };
const timings: Timing[] = [];

async function timed<T>(label: string, opCount: number | undefined, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const result = await fn();
  timings.push({ label, ms: Date.now() - t0, opCount });
  return result;
}

function report() {
  console.log("\n=== Load test summary ===");
  console.log(`${CONDUCTORS} conductor(s) x ${AGENTS_PER_CONDUCTOR} agent(s)/conductor = ${TOTAL_AGENTS} total agents\n`);
  for (const t of timings) {
    const rate = t.opCount ? ` (${(t.opCount / (t.ms / 1000)).toFixed(1)} ops/sec, ${t.opCount} ops)` : "";
    console.log(`  ${t.label}: ${t.ms}ms${rate}`);
  }
  console.log("");
}

const stressWorkers: ChildProcess[] = [];
if (STRESS_CPU) {
  const coreCount = os.cpus().length;
  console.log(`[STRESS] Spawning ${coreCount} CPU-saturating background workers (one per core) for the duration of this run...`);
  for (let i = 0; i < coreCount; i++) {
    stressWorkers.push(spawnProcess(process.execPath, ["-e", "while(true){}"], { stdio: "ignore" }));
  }
}

try {
await runScenario(async (scenario) => {
  console.log(`Load test starting: ${CONDUCTORS} conductor(s) x ${AGENTS_PER_CONDUCTOR} agent(s)/conductor = ${TOTAL_AGENTS} total agents${STRESS_CPU ? " [STRESS_CPU active]" : ""}`);

  const players: PlayerApp[] = [];
  const conductorReps: PlayerApp[] = []; // one representative per conductor, for dhtSync -- agents co-located on the same conductor already trivially share local storage, dhtSync is specifically about cross-conductor gossip.
  await timed("setup: conductors + agent-cells", TOTAL_AGENTS, async () => {
    for (let c = 0; c < CONDUCTORS; c++) {
      const conductor = await scenario.addConductor();
      const conductorPlayers = await installManyAgents(conductor, AGENTS_PER_CONDUCTOR, `c${c}`);
      players.push(...conductorPlayers);
      conductorReps.push(conductorPlayers[0]);
    }
  });
  await timed("setup: shareAllAgents", undefined, () => scenario.shareAllAgents());

  if (process.env.LOAD_CHECK_LOCAL_PEER_STORE === "1") {
    for (let c = 0; c < CONDUCTORS; c++) {
      const conductor = players[c * AGENTS_PER_CONDUCTOR].conductor;
      const infos = await conductor.adminWs().agentInfo({ dna_hashes: null });
      console.log(`[DATA] conductor ${c}'s own peer store reports ${infos.length} agent(s) (it locally hosts ${AGENTS_PER_CONDUCTOR})`);
    }
  }

  const geoPresenceOf = (p: PlayerApp) => getZomeCaller(p.cells[0], "geo_presence");
  const catalogOf = (p: PlayerApp) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: PlayerApp) => getZomeCaller(p.cells[0], "dispatch");
  const ledgerOf = (p: PlayerApp) => getZomeCaller(p.cells[0], "ledger");

  const customer = players[0];
  const drivers = players.slice(1);
  console.log(`(1 customer, ${drivers.length} drivers)`);

  // --- Setup: catalog + a throwaway order, purely to learn the geohash
  // string the coordinator itself derives for ST_PETE at its own precision
  // -- avoids re-implementing geohash encoding in the test. Placed before
  // any driver goes online, so its own fan-out signal (if any) can't be
  // confused with the *measured* order's signal in phase 2.
  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Load Test Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", {
    catalog_ref: catalogRef,
    name: "Empanada",
    price_cents: 600,
    available: true,
  });
  const menuItemRef = actionHash(menuItemRecord);
  const throwawayOrder = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: customer.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 600,
    dropoff: ST_PETE,
    max_delivery_fee: null,
  });
  const geohash = decodeEntry<{ dropoff_geohash: string }>(throwawayOrder).dropoff_geohash;

  // === Phase 1: presence-beacon write throughput + staged single-anchor
  // read-latency-vs-population (architecture plan §11.3) ===
  // All drivers publish to the *same* ST_PETE cell/bucket -- i.e. the same
  // single anchor -- so writing them in batches and timing a read after
  // each batch directly answers the open "does read latency grow with
  // single-anchor population" question with real data, instead of guessing
  // whether sub-anchor sharding is worth building.
  const BATCH_SIZE = Math.max(1, Math.ceil(drivers.length / 5));
  const latencyVsPopulation: { population: number; ms: number }[] = [];
  for (let start = 0; start < drivers.length; start += BATCH_SIZE) {
    const batch = drivers.slice(start, start + BATCH_SIZE);
    await Promise.all(batch.map((d) => geoPresenceOf(d)("announce_online", { location: ST_PETE, capabilities: ["Food"] })));
    await dhtSync(conductorReps, conductorReps[0].cells[0].cell_id[0]);
    const population = Math.min(start + BATCH_SIZE, drivers.length);
    const t0 = Date.now();
    const nearbyProviders = await geoPresenceOf(customer)<{ provider: Uint8Array }[]>("get_nearby_providers", geohash);
    const ms = Date.now() - t0;
    latencyVsPopulation.push({ population, ms });
    assert.equal(nearbyProviders.length, population, `expected ${population} discoverable beacons after this batch, got ${nearbyProviders.length}`);
  }
  console.log(`[PASS] All ${drivers.length} beacons discoverable via the current-bucket anchor, written and read in ${latencyVsPopulation.length} batches`);
  console.log("[DATA] get_nearby_providers latency vs. single-anchor population:");
  for (const { population, ms } of latencyVsPopulation) {
    console.log(`         ${population} beacons -> ${ms}ms`);
  }

  // Re-share agent info right before signaling, later than the one-time
  // setup-time shareAllAgents() call -- testing whether the earlier
  // "one delivery per destination conductor" finding is a real Holochain
  // production limitation, or an artifact of that one-time snapshot having
  // caught co-located agents' network endpoints before they'd finished
  // initializing. If a fresh share right before the signal fixes delivery,
  // this points at test-harness timing, not a genuine protocol limitation.
  if (process.env.LOAD_RESHARE_BEFORE_SIGNAL === "1") {
    await timed("phase2: re-share agent info immediately before signaling", undefined, () => scenario.shareAllAgents());
  }

  // === Phase 2: the fan-out cap, observed live against a real dense pool ===
  // Logs arrival *timestamps*, not just a final count -- send_remote_signal's
  // real implementation (checked directly in holochain-0.6.3's own source,
  // not assumed) signs a distinct payload per recipient *sequentially*, one
  // `keystore.sign_raw().await` at a time, inside a `tokio::task::spawn` the
  // calling extern never awaits -- so a low count within a short window could
  // mean "still working through the signing queue," not "lost." Timestamps
  // distinguish those two stories; a final count alone can't.
  const received = new Set<string>();
  const arrivalMs: number[] = [];
  const phase2Start = Date.now();
  const unsubscribes = drivers.map((d) =>
    d.appWs.on("signal", (signal: Signal) => {
      if (signal.type !== "app") return;
      // The wire-level RemoteSignal::NewOrderPosted the requester sends is
      // re-emitted client-side as LocalSignal::NewOrderNearby by
      // recv_remote_signal (see dispatch_coordinator::signals) -- the
      // client only ever sees the local variant name.
      if ("NewOrderNearby" in (signal.value.payload as object)) {
        if (!received.has(d.agentPubKey.toString())) arrivalMs.push(Date.now() - phase2Start);
        received.add(d.agentPubKey.toString());
      }
    }),
  );
  const driverIndexOf = new Map(drivers.map((d, i) => [d.agentPubKey.toString(), i]));

  const measuredOrder = await timed("phase2: request_delivery (triggers capped fan-out)", undefined, () =>
    dispatchOf(customer)<HcRecord>("request_delivery", {
      merchant: customer.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: menuItemRef, quantity: 1 }],
      order_total: 600,
      dropoff: ST_PETE,
      max_delivery_fee: null,
    }),
  );
  const measuredOrderRef = actionHash(measuredOrder);

  await new Promise((resolve) => setTimeout(resolve, SIGNAL_WAIT_MS));
  unsubscribes.forEach((unsub) => unsub());

  console.log(`[INFO] ${received.size} of ${drivers.length} drivers received the fan-out signal (cap is ${MAX_SIGNAL_FANOUT}) within a ${SIGNAL_WAIT_MS}ms window`);
  console.log(`[DATA] signal arrival times (ms after request_delivery returned): [${arrivalMs.join(", ")}]`);
  console.log(`[DATA] driver indices (0-based, within the ${drivers.length}-driver pool) that received it: [${[...received].map((k) => driverIndexOf.get(k)).sort((a, b) => a! - b!).join(", ")}]`);
  assert.ok(
    received.size <= MAX_SIGNAL_FANOUT,
    `fan-out must never exceed MAX_SIGNAL_FANOUT even with ${drivers.length} real candidates -- got ${received.size}`,
  );
  console.log(`[PASS] Signal fan-out stayed capped at <= ${MAX_SIGNAL_FANOUT} against a real pool of ${drivers.length} drivers`);

  if (drivers.length > MAX_SIGNAL_FANOUT) {
    const unsignaled = drivers.find((d) => !received.has(d.agentPubKey.toString()));
    assert.ok(unsignaled, "expected at least one driver outside the signaled cap given pool size exceeds the cap");
    await timed("phase2: dhtSync before polling backstop", undefined, () => dhtSync(conductorReps, conductorReps[0].cells[0].cell_id[0]));
    const backstopOrders = await timed("phase2: get_open_orders_near (polling backstop, read)", undefined, () =>
      dispatchOf(unsignaled!)<HcRecord[]>("get_open_orders_near", geohash),
    );
    const found = backstopOrders.some((r) => bytesEqual(actionHash(r), measuredOrderRef));
    assert.ok(found, "a driver outside the signaled cap must still find the order via the polling backstop");
    console.log("[PASS] A driver outside the signaled cap still finds the order via the polling backstop");
  } else {
    console.log(`[INFO] driver pool (${drivers.length}) did not exceed the cap (${MAX_SIGNAL_FANOUT}) -- increase LOAD_CONDUCTORS/LOAD_AGENTS_PER_CONDUCTOR to exercise this properly`);
  }

  // === Phase 2b: does a *warm* connection improve fan-out delivery? ===
  // Phase 2's cold fan-out only reached 3 of 35 -- and re-running with a 60s
  // window (LOAD_SIGNAL_WAIT_MS=60000) showed all 3 arriving within ~220ms
  // of each other, nothing trickling in afterward. That rules out "slow
  // sequential signing" (send_remote_signal's real impl, checked directly
  // in holochain-0.6.3's source, signs each recipient sequentially in a
  // spawned, un-awaited task -- a queueing delay would show arrivals spread
  // across the window, not all-or-nothing in the first fraction of a
  // second). It's consistent instead with a hard, near-instant drop for
  // most recipients -- plausibly because the customer has no live QUIC
  // connection yet to a driver who came online only seconds earlier.
  // Testable without touching Rust: have every driver signal the customer
  // first (submit_bid already does this -- see bids.rs's
  // RemoteSignal::BidPlaced to the order's requester), which should
  // establish/warm that connection pair in both directions, then fire a
  // *second* order at the exact same pool and compare.
  console.log("[INFO] Phase 2b: warming connections via submit_bid (driver -> customer signal), then re-measuring fan-out to the same pool...");
  await timed("phase2b: submit_bid from all drivers (warms driver->customer connections)", drivers.length, () =>
    Promise.all(
      drivers.map((d) =>
        dispatchOf(d)("submit_bid", {
          order_ref: measuredOrderRef,
          eta_seconds: 900,
          price_offer: 400,
          collateral_commitment: { account: "stub", amount: 100, ledger_txn_ref: "pending" },
        }).catch(() => null),
      ),
    ),
  );
  await timed("phase2b: dhtSync after warm-up bids", undefined, () => dhtSync(conductorReps, conductorReps[0].cells[0].cell_id[0]));

  const warmReceived = new Set<string>();
  const warmArrivalMs: number[] = [];
  const phase2bStart = Date.now();
  const warmUnsubscribes = drivers.map((d) =>
    d.appWs.on("signal", (signal: Signal) => {
      if (signal.type !== "app") return;
      if ("NewOrderNearby" in (signal.value.payload as object)) {
        if (!warmReceived.has(d.agentPubKey.toString())) warmArrivalMs.push(Date.now() - phase2bStart);
        warmReceived.add(d.agentPubKey.toString());
      }
    }),
  );
  await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: customer.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 600,
    dropoff: ST_PETE,
    max_delivery_fee: null,
  });
  await new Promise((resolve) => setTimeout(resolve, SIGNAL_WAIT_MS));
  warmUnsubscribes.forEach((unsub) => unsub());

  console.log(`[INFO] warm fan-out: ${warmReceived.size} of ${drivers.length} drivers received the signal (cold was ${received.size} of ${drivers.length})`);
  console.log(`[DATA] warm signal arrival times (ms after request_delivery returned): [${warmArrivalMs.join(", ")}]`);

  // === Phase 3: ledger checkpoints under genuinely concurrent multi-author writes ===
  // Unlike checkpoint.test.ts (one payer, sequential), every driver here is
  // a *different* author, all writing to the *same* recipient's
  // AgentToTransaction/AgentToBalanceCheckpoint anchor at the same moment --
  // exactly the concurrency case the append-only (not mutable) checkpoint
  // design exists to survive without lost updates.
  const AMOUNT_PER_TXN = 10;
  await timed("phase3: release_on_completion, all drivers concurrently to one recipient", drivers.length, () =>
    Promise.all(
      drivers.map((d) =>
        ledgerOf(d)("release_on_completion", {
          order_ref: catalogRef,
          from: d.agentPubKey,
          to: customer.agentPubKey,
          amount: AMOUNT_PER_TXN,
        }),
      ),
    ),
  );

  await timed("phase3: dhtSync before balance read", undefined, () => dhtSync(conductorReps, conductorReps[0].cells[0].cell_id[0]));
  const customerBalance = await timed("phase3: get_balance (recipient, read)", undefined, () =>
    ledgerOf(customer)<number>("get_balance", customer.agentPubKey),
  );
  const expectedBalance = drivers.length * AMOUNT_PER_TXN;
  assert.equal(customerBalance, expectedBalance, `no lost updates: balance should reflect all ${drivers.length} concurrent transactions`);
  console.log(`[PASS] No lost updates: recipient balance (${customerBalance}) matches all ${drivers.length} concurrent transactions, despite concurrent authorship`);

  report();
});
} finally {
  if (stressWorkers.length) {
    console.log(`[STRESS] Killing ${stressWorkers.length} background workers...`);
    stressWorkers.forEach((w) => w.kill("SIGKILL"));
  }
}
