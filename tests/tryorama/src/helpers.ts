// Shared across all three test files -- pulled out once these stopped being
// "a couple of lines" and started being copy-pasted three times over.
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { decode } from "@msgpack/msgpack";
import type { CallableCell, Conductor, PlayerApp, Scenario } from "@holochain-open-dev/tryorama";
import { dhtSync, enableAndGetAgentApp, getZomeCaller } from "@holochain-open-dev/tryorama";
import { dhtLocationFrom32, encodeHashToBase64 } from "@holochain/client";
import type { AppBundleSource, Record as HcRecord, Signal } from "@holochain/client";

export const HAPP_PATH = fileURLToPath(new URL("../../../workdir/relay.happ", import.meta.url));
export const appSource: AppBundleSource = { type: "path", value: HAPP_PATH };

/// The protocol's limits, generated from the Rust (`integrity_support::limits`)
/// for the app -- the same numbers validation enforces.
export * as limits from "../../../web/src/holochain/generated.js";

/// A photo the size a phone's resized 640px JPEG really is (~150KB) --
/// many times what one sealed box holds, so it proves sealing in chunks.
export const FULL_SIZE_PHOTO = `data:image/jpeg;base64,${"AAAA".repeat(37_500)}`;

export const ST_PETE = { lat: 27.7676, lon: -82.6403 };
export const NYC = { lat: 40.7128, lon: -74.006 };

export function actionHash(record: HcRecord): Uint8Array {
  return record.signed_action.hashed.hash;
}

export function decodeEntry<T>(record: HcRecord): T {
  const entry = record.entry as { Present?: { entry: Uint8Array } };
  assert.ok(entry.Present, "record has no entry data");
  return decode(entry.Present.entry) as T;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export function waitForSignal(
  ws: { on: (evt: "signal", cb: (s: Signal) => void) => () => void },
  predicate: (payload: any) => boolean,
  timeoutMs: number,
): Promise<any | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(null);
    }, timeoutMs);
    const unsubscribe = ws.on("signal", (signal) => {
      if (signal.type !== "app") return;
      if (predicate(signal.value.payload)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(signal.value.payload);
      }
    });
  });
}

/// Retries `fn` until it stops throwing. Used wherever a call can legitimately
/// fail transiently -- a cross-agent read racing gossip -- rather than a
/// single call that assumes the underlying conductor workflow is
/// synchronous with the zome call that kicked it off.
export async function retryUntilOk<T>(fn: () => Promise<T>, maxAttempts = 20, delayMs = 500): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("unreachable");
}

/// Re-reads until `done` accepts the result -- for reads that are already
/// valid but may not reflect a just-gossiped write yet. Returns the last
/// result either way, so the caller's own assertion reports what was seen.
export async function retryUntil<T>(fn: () => Promise<T>, done: (value: T) => boolean, maxAttempts = 20, delayMs = 500): Promise<T> {
  let value = await fn();
  for (let attempt = 1; attempt < maxAttempts && !done(value); attempt++) {
    await new Promise((r) => setTimeout(r, delayMs));
    value = await fn();
  }
  return value;
}

/// DNA properties every test network runs with, beneath any a test sets: a
/// report window short enough to wait out, so a store's payment for the
/// food settles within a test; and no store listing stake, so a store
/// starts at a zero balance like every account. A test of either sets its
/// own.
export const TEST_PROPERTIES = { report_window_secs: 2, store_listing_stake: 0 };

/// The `RoleSettings` installing with `properties` (merged over
/// `TEST_PROPERTIES`). Discovered against the real admin API: it's tagged
/// `{type, value}`, every field is a required map key despite being an
/// `Option`, and agent keys inside `properties` must be base64 strings
/// (`encodeHashToBase64`) -- raw bytes don't round-trip through this
/// request's encoder.
export function rolesSettingsWith(properties: Record<string, unknown> = {}) {
  return {
    relay: { type: "provisioned" as const, value: { membrane_proof: undefined, modifiers: { network_seed: undefined, properties: { ...TEST_PROPERTIES, ...properties } } } },
  };
}

/// An app to install with custom DNA properties (see `RelayDnaProperties`),
/// for `scenario.addPlayersWithApps`. Properties are part of the DNA hash,
/// so every player that should share a network needs the same ones.
export function appWithProperties(properties: Record<string, unknown>) {
  return { appBundleSource: appSource, options: { rolesSettings: rolesSettingsWith(properties) } };
}

/// The app as every test installs it, on the test network's properties.
export const testApp = appWithProperties({});

/// Installs `count` separate agent-cells on one already-running conductor,
/// for the load-test harness (`load-test.ts`) -- N real, independent
/// on-chain identities without paying N-times the conductor/lair-keystore
/// process-startup cost `scenario.addPlayersWithApps` would (that helper
/// creates one full conductor process *per* player, confirmed via its own
/// doc comment and implementation). Each agent still gets its own genuine
/// source chain and DHT identity -- what's shared is the OS process, not
/// the cryptographic identity or the correctness of anything being tested.
///
/// This also mirrors the *actual* Holo Host deployment model better than
/// one-conductor-per-user would: a smaller number of real host machines,
/// each serving many end-user agent identities -- not a hack purely for
/// convenience.
///
/// One real caveat, named rather than hidden: agents co-located on one
/// conductor process may not perfectly replicate real cross-machine gossip
/// latency (though the DHT/validation/storage logic they exercise is
/// identical regardless of process topology). This harness measures write/
/// read throughput and anchor-contention behavior, which that caveat
/// doesn't undermine -- it does NOT attempt to measure real WAN gossip
/// latency, which is a separate, still-open limitation.
export async function installManyAgents(conductor: Conductor, count: number, labelPrefix: string): Promise<PlayerApp[]> {
  const port = await conductor.attachAppInterface();
  const adminWs = conductor.adminWs();
  const players: PlayerApp[] = [];
  for (let i = 0; i < count; i++) {
    const agentPubKey = await adminWs.generateAgentPubKey();
    const installedAppId = `${labelPrefix}-${i}`;
    const appInfo = await conductor.installApp({ appBundleSource: appSource, options: { agentPubKey, installedAppId, rolesSettings: rolesSettingsWith() } });
    const issued = await adminWs.issueAppAuthenticationToken({ installed_app_id: appInfo.installed_app_id });
    const appWs = await conductor.connectAppWs(issued.token, port);
    const agentApp = await enableAndGetAgentApp(adminWs, appWs, appInfo);
    players.push({ conductor, appWs, ...agentApp });
  }
  return players;
}

/// Swaps the `test-utils` build of the named coordinator zomes into a
/// player's cell, adding the raw `test_create_link`/`test_delete_link`/
/// `test_get_link_hashes` externs (see `raw_link_test_externs!`). Lets a
/// test attempt exactly the links a malicious peer could write and assert
/// link validation rejects them. Coordinators aren't part of the DNA hash,
/// so the swap leaves the cell on the same DNA as everyone else. Build
/// first with `npm run build:test-coordinators`.
export async function useTestCoordinators(player: PlayerApp, zomes: string[], cell: CallableCell = player.cells[0]): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const wasmDir = fileURLToPath(new URL("../../../target/test-utils/wasm32-unknown-unknown/release/", import.meta.url));
  const adminWs = player.conductor.adminWs();
  for (const zome of zomes) {
    const file = `${zome}.wasm`;
    const bytes = new Uint8Array(await readFile(`${wasmDir}${file}`));
    await adminWs.updateCoordinators({
      cell_id: cell.cell_id,
      source: { type: "bundle", value: { manifest: { zomes: [{ name: zome, hash: null, path: file, dependencies: [{ name: `${zome}_integrity` }] }] }, resources: { [file]: bytes } } },
    } as never);
    await warmUp(player, zome, cell);
  }
}

/// A harmless read in each zome a test swaps in -- what `warmUp` calls.
const WARM_UP: Record<string, (player: PlayerApp) => [string, unknown]> = {
  dispatch: () => ["get_network_terms", null],
  catalog: () => ["list_my_catalogs", null],
  ledger: (player) => ["get_balance", player.agentPubKey],
  reputation: (player) => ["get_reputation_summary", { Driver: player.agentPubKey }],
  attestation: () => ["prepare_device", null],
  profiles: () => ["get_my_name", null],
  account: () => ["my_recovery_plan", null],
};

/// What a call can meet while a swapped-in coordinator settles: compiling
/// it, and granting the caller's signing capability on its first call, can
/// outlast a request's 60 seconds on a slow CI runner; and for a moment
/// after the swap the conductor may not have the new code stored yet
/// ("Missing WASM source").
const SETTLING = /timed out|Missing WASM source/i;

/// Calls a harmless read in a zome until its conductor answers it.
async function warmUp(player: PlayerApp, zome: string, cell: CallableCell = player.cells[0]): Promise<void> {
  const read = WARM_UP[zome];
  if (!read) throw new Error(`add a harmless read for the ${zome} zome to WARM_UP`);
  const [fn_name, payload] = read(player);
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await cell.callZome({ zome_name: zome, fn_name, payload });
      return;
    } catch (err) {
      if (!SETTLING.test(String(err))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`the ${zome} zome never answered after its coordinator was swapped in`);
}

/// An agent key in the form Holochain stores it as a link base: the same
/// 32-byte core, retyped from Agent to Entry (holo_hash's
/// `From<AgentPubKey> for AnyLinkableHash`). Needed when a raw test link
/// names an agent as its base.
export function agentAsLinkBase(agentPubKey: Uint8Array): Uint8Array {
  const AGENT_PREFIX = [0x84, 0x20, 0x24];
  assert.deepEqual([...agentPubKey.slice(0, 3)], AGENT_PREFIX, "not an agent public key");
  const retyped = new Uint8Array(agentPubKey);
  retyped[1] = 0x21;
  return retyped;
}

/// The store accepting a delivery order -- what opens it to drivers -- then
/// a sync, so drivers see it open. Retried until the store has the order.
export async function acceptOrder(store: PlayerApp, orderRef: Uint8Array, players: PlayerApp[]): Promise<HcRecord> {
  const accepted = await retryUntilOk(() => store.cells[0].callZome<HcRecord>({ zome_name: "dispatch", fn_name: "accept_delivery_order", payload: { order_original_action: orderRef } }));
  await dhtSync(players, store.cells[0].cell_id[0]);
  return accepted;
}

/// One delivery handoff: the driver records it, then the other party (the
/// store collecting from, the customer handing to) confirms it -- once the
/// driver's record has reached them -- and the confirmation reaches
/// everyone, so the driver can pick up (or anyone complete) on it. Returns
/// the leg.
export async function handOff(
  driver: PlayerApp,
  recipient: PlayerApp,
  orderRef: Uint8Array,
  kind: "MerchantHandoff" | "CustomerHandoff",
  players: PlayerApp[],
  extra: { geo_at_completion?: { lat: number; lon: number }; photo_data_uri?: string } = {},
): Promise<Uint8Array> {
  const leg = await retryUntilOk(() =>
    driver.cells[0].callZome<HcRecord>({
      zome_name: "attestation",
      fn_name: "record_leg",
      payload: { order_ref: orderRef, sequence: kind === "MerchantHandoff" ? 0 : 1, kind, to: recipient.agentPubKey, geo_at_completion: ST_PETE, photo_data_uri: "", ...extra },
    }),
  );
  await dhtSync(players, driver.cells[0].cell_id[0]);
  await retryUntilOk(() => recipient.cells[0].callZome({ zome_name: "attestation", fn_name: "acknowledge_leg", payload: actionHash(leg) }));
  await dhtSync(players, recipient.cells[0].cell_id[0]);
  return actionHash(leg);
}

/// `count` players on their own conductors, with DNA properties that can
/// name some of them (an issuer) -- `properties` gets every player's key, in
/// order, before anything is installed.
export async function setupPlayersWithProperties(scenario: Scenario, count: number, properties: (keys: string[]) => Record<string, unknown>): Promise<PlayerApp[]> {
  // One at a time, as `setupArbitratedPlayers` does: conductors started
  // concurrently didn't find each other.
  const conductors: Conductor[] = [];
  for (let i = 0; i < count; i++) conductors.push(await scenario.addConductor());
  const keys: Uint8Array[] = [];
  for (const conductor of conductors) keys.push(await conductor.adminWs().generateAgentPubKey());
  const rolesSettings = rolesSettingsWith(properties(keys.map(encodeHashToBase64)));
  const players = await scenario.installAppsForPlayers(
    conductors.map(() => ({ appBundleSource: appSource, options: { rolesSettings } })),
    keys.map((agentPubKey, i) => ({ agentPubKey, conductor: conductors[i] })),
  );
  await scenario.shareAllAgents();
  return players;
}

/// The caller's latest ledger entry and its hash, or nulls before any --
/// what a hand-built (forged) entry would have to chain from.
/// The orders a driver has in hand, as their ledger carries it.
export interface InHand {
  orders: number;
  priority: boolean;
}

export const EMPTY_HANDS: InHand = { orders: 0, priority: false };

export async function latestLedgerEntry(player: PlayerApp): Promise<{ hash: Uint8Array | null; balance: number; in_hand: InHand }> {
  const page = await player.cells[0].callZome<{ entries: HcRecord[] }>({ zome_name: "ledger", fn_name: "list_my_ledger", payload: { before: null } });
  const latest = page.entries[0];
  if (!latest) return { hash: null, balance: 0, in_hand: EMPTY_HANDS };
  const entry = decodeEntry<{ balance: number; in_hand: InHand }>(latest);
  return { hash: actionHash(latest), balance: entry.balance, in_hand: entry.in_hand };
}

/// The order's status as `player` reads it.
export async function deliveryStatus(player: PlayerApp, orderRef: Uint8Array): Promise<string> {
  const record = await player.cells[0].callZome<HcRecord>({ zome_name: "dispatch", fn_name: "get_order", payload: orderRef });
  return decodeEntry<{ status: string }>(record).status;
}

/// Runs `step`, accepting `alreadyDone` as success -- each app does its own
/// steps as soon as it hears, so a test doing the same step may find it
/// done.
async function stepOrDone(step: () => Promise<unknown>, alreadyDone: RegExp): Promise<void> {
  try {
    await step();
  } catch (err) {
    if (!alreadyDone.test(String(err))) throw err;
  }
}

/// The driver whose bid was accepted committing to the order (their
/// collateral set aside), then the store starting to cook it. Each one's
/// app does its step on its own; this does them too, so a test needn't
/// wait, and checks the order ends up cooking.
export async function commitAndCook(driver: PlayerApp, store: PlayerApp, orderRef: Uint8Array, players: PlayerApp[]): Promise<void> {
  // A driver's earlier deliveries count against their carry limit until
  // their app settles them, on its own schedule -- up to a minute on a slow
  // runner.
  await retryUntilOk(
    () => stepOrDone(() => driver.cells[0].callZome({ zome_name: "dispatch", fn_name: "commit_to_order", payload: orderRef }), /already committed/),
    60,
    1000,
  );
  await dhtSync(players, driver.cells[0].cell_id[0]);
  await retryUntilOk(() =>
    stepOrDone(() => store.cells[0].callZome({ zome_name: "dispatch", fn_name: "start_cooking", payload: orderRef }), /isn't waiting on the kitchen/),
  );
  await dhtSync(players, store.cells[0].cell_id[0]);
  await retryUntil(() => deliveryStatus(driver, orderRef), (s) => ["MerchantConfirmed", "DriverAtStore", "PickedUp"].includes(s));
}

/// The store handing the order to its driver -- the driver's pickup leg,
/// acknowledged by the store, which checks them in if it hadn't -- and the
/// driver picking it up on that record (their app does so on its own too).
/// Returns the pickup leg.
export async function collectFromStore(driver: PlayerApp, store: PlayerApp, orderRef: Uint8Array, players: PlayerApp[]): Promise<Uint8Array> {
  const leg = await handOff(driver, store, orderRef, "MerchantHandoff", players);
  await pickUp(driver, orderRef);
  await dhtSync(players, driver.cells[0].cell_id[0]);
  return leg;
}

/// The driver picking up an order the store has handed over -- or finding
/// their app already has.
export async function pickUp(driver: PlayerApp, orderRef: Uint8Array): Promise<void> {
  await retryUntilOk(async () => {
    if ((await deliveryStatus(driver, orderRef)) === "PickedUp") return;
    await driver.cells[0].callZome({ zome_name: "dispatch", fn_name: "pick_up_order", payload: orderRef });
  });
}

/// The network's default time source (drand quicknet) -- what deadline
/// claims prove the time with. Tests fetch its current round, as apps do.
const TIME_RELAYS = ["https://api.drand.sh", "https://drand.cloudflare.com"];
const TIME_CHAIN = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

/// The time source's current round.
export async function currentBeacon(): Promise<{ round: number; signature: Uint8Array }> {
  for (const relay of TIME_RELAYS) {
    try {
      const response = await fetch(`${relay}/${TIME_CHAIN}/public/latest`);
      if (!response.ok) continue;
      const { round, signature } = (await response.json()) as { round: number; signature: string };
      return { round, signature: Uint8Array.from(Buffer.from(signature, "hex")) };
    } catch {
      // The next relay.
    }
  }
  throw new Error("couldn't reach the time source");
}

/// Holochain's refusals of a commit that wrote nothing -- safe to repeat, as
/// the app's client does (web/src/holochain/client.ts `RETRYABLE`): a record
/// validation needs that hasn't arrived, or the agent's own conductor (its
/// scheduled upkeep, a store's auto-accept) writing to the chain mid-call.
const RETRYABLE = /could not be completed but may be retried|source chain head has moved/;

/// A zome caller that, like the app's client, repeats a call Holochain
/// refused before writing anything.
export function retryingCaller(cell: CallableCell, zome: string) {
  const caller = getZomeCaller(cell, zome);
  return async <T>(fn_name: string, payload?: unknown): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await caller<T>(fn_name, payload);
      } catch (err) {
        if (attempt >= 3 || !RETRYABLE.test(String(err))) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  };
}

/// Shares one network's peers among the conductors on it -- for a test that
/// runs more than one network, where `scenario.shareAllAgents` fails: a
/// conductor knows nothing of a network it isn't on.
export async function shareAgentsOn(conductors: Conductor[], network: Uint8Array): Promise<void> {
  const infos = (await Promise.all(conductors.map((c) => c.adminWs().agentInfo({ dna_hashes: [network] } as never)))).flat();
  await Promise.all(conductors.map((c) => c.adminWs().addAgentInfo({ agent_infos: infos } as never)));
}

/// A recovery phrase's key, as the app derives one: an Ed25519 key in the
/// form Holochain carries agent keys (a 3-byte prefix, 32 bytes, 4 of
/// location).
export function phraseKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const key = new Uint8Array([0x84, 0x20, 0x24, ...raw, ...dhtLocationFrom32(raw)]);
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  return { key, sign: (message: Uint8Array) => new Uint8Array(sign(null, message, createPrivateKey({ key: der, format: "der", type: "pkcs8" }))) };
}

/// What a phrase's key signs -- `account_types::phrase_message`.
export const phraseMessage = (predecessor: Uint8Array, successor: Uint8Array, head: Uint8Array) =>
  new Uint8Array([...new TextEncoder().encode("relay-recovery:v1:"), ...predecessor, 58, ...successor, 58, ...head]);

/// `player`'s account on a new install, as a new phone would get it: their
/// app -- with everything only their device held -- uninstalled, then
/// installed again for the same key, restored from the network
/// (Holochain's `restore_from_dht`; docs/RECOVERY.md). What this can't stand in
/// for is the key crossing to another keystore: here it never left. Pass
/// the `properties` the player was installed with.
export async function restoreInPlace(player: PlayerApp, properties: Record<string, unknown> = {}): Promise<PlayerApp> {
  const admin = player.conductor.adminWs();
  const appId = player.appId;
  await admin.uninstallApp({ installed_app_id: appId });
  await admin.installApp({ source: appSource, agent_key: player.agentPubKey, installed_app_id: appId, roles_settings: rolesSettingsWith(properties), restore_from_dht: true } as never);
  // Awaiting restore until the chain is back, then disabled, ready to enable.
  const app = await retryUntil(
    async () => (await admin.listApps({})).find((a) => a.installed_app_id === appId)!,
    (a) => a.status.type !== ("awaiting_restore" as string),
    120,
    1000,
  );
  assert.equal(app.status.type, "disabled", `restored, not ${JSON.stringify(app.status)}`);
  const port = await player.conductor.attachAppInterface();
  const issued = await admin.issueAppAuthenticationToken({ installed_app_id: appId });
  const appWs = await player.conductor.connectAppWs(issued.token, port);
  const agentApp = await enableAndGetAgentApp(admin, appWs, app);
  // The test client signs calls with a key a grant lets in -- one more of
  // the device's private entries a restore doesn't bring back.
  for (const cell of agentApp.cells) await admin.authorizeSigningCredentials(cell.cell_id);
  return { conductor: player.conductor, appWs, ...agentApp };
}
