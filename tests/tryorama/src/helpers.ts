// Shared across all three test files -- pulled out once these stopped being
// "a couple of lines" and started being copy-pasted three times over.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { decode } from "@msgpack/msgpack";
import type { Conductor, PlayerApp, Scenario } from "@holochain-open-dev/tryorama";
import { enableAndGetAgentApp } from "@holochain-open-dev/tryorama";
import { encodeHashToBase64 } from "@holochain/client";
import type { AppBundleSource, Record as HcRecord, Signal } from "@holochain/client";

export const HAPP_PATH = fileURLToPath(new URL("../../../workdir/relay.happ", import.meta.url));
export const appSource: AppBundleSource = { type: "path", value: HAPP_PATH };

export const ST_PETE = { lat: 27.7676, lon: -82.6403 };
export const NYC = { lat: 40.7128, lon: -74.006 };

export function actionHash(record: HcRecord): Uint8Array {
  return record.signed_action.hashed.hash;
}

export function decodeEntry<T>(record: HcRecord): T {
  const entry = record.entry as { Present?: { entry_type: string; entry: Uint8Array | [unknown, Uint8Array] } };
  assert.ok(entry.Present, "record has no entry data");
  // A countersigned entry's wire shape is [CounterSigningSessionData, bytes]
  // -- the app-entry bytes we actually want to decode are the second element.
  const raw = entry.Present.entry_type === "CounterSign"
    ? (entry.Present.entry as [unknown, Uint8Array])[1]
    : (entry.Present.entry as Uint8Array);
  return decode(raw) as T;
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
/// fail transiently -- a countersigning chain lock that hasn't cleared yet,
/// or a cross-agent read racing gossip -- rather than a single call that
/// assumes the underlying conductor workflow is synchronous with the
/// zome call that kicked it off.
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

/// The dispute/arbitration subsystem (plan §8) needs an arbitrator roster
/// baked into DNA properties -- a value every player must install with
/// *identically*, since `properties` is part of the DNA hash. That pubkey
/// doesn't exist until runtime, so unlike every other test's player setup,
/// this pre-generates it via each conductor's own admin websocket
/// (`addConductor` + `generateAgentPubKey`) before installing anything, then
/// installs all three players with a matching `rolesSettings` override.
///
/// Two format quirks here were only discovered by testing against the real
/// admin API, not documented anywhere obvious: `RoleSettings` is tagged
/// `{type, value}` (`#[serde(tag = "type", content = "value", rename_all =
/// "snake_case")]` in holochain_types 0.6.3), and every field on it and on
/// `modifiers` is a required map key despite being an `Option`. And a raw
/// `Uint8Array` (an `AgentPubKey`'s native JS form) nested inside the
/// `properties` value doesn't round-trip through this specific request's
/// encoder, even though AgentPubKeys pass through fine as top-level zome-call
/// arguments elsewhere -- so the roster is base64 hash strings
/// (`encodeHashToBase64`, matching `AgentPubKey::to_string()` on the Rust
/// side), not raw bytes.
export async function setupArbitratedPlayers(scenario: Scenario) {
  const customerConductor = await scenario.addConductor();
  const driverConductor = await scenario.addConductor();
  const arbitratorConductor = await scenario.addConductor();

  const customerKey = await customerConductor.adminWs().generateAgentPubKey();
  const driverKey = await driverConductor.adminWs().generateAgentPubKey();
  const arbitratorKey = await arbitratorConductor.adminWs().generateAgentPubKey();

  const rolesSettings = {
    relay: {
      type: "provisioned" as const,
      value: {
        membrane_proof: undefined,
        modifiers: {
          network_seed: undefined,
          properties: { arbitrators: [encodeHashToBase64(arbitratorKey)] },
        },
      },
    },
  };

  const [customer, driver, arbitrator] = await scenario.installAppsForPlayers(
    [
      { appBundleSource: appSource, options: { rolesSettings } },
      { appBundleSource: appSource, options: { rolesSettings } },
      { appBundleSource: appSource, options: { rolesSettings } },
    ],
    [
      { agentPubKey: customerKey, conductor: customerConductor },
      { agentPubKey: driverKey, conductor: driverConductor },
      { agentPubKey: arbitratorKey, conductor: arbitratorConductor },
    ],
  );
  await scenario.shareAllAgents();

  return { customer, driver, arbitrator, all: [customer, driver, arbitrator] };
}

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
/// latency, which is a separate, still-open limitation (see the plan's own
/// §9 follow-up discussion).
export async function installManyAgents(conductor: Conductor, count: number, labelPrefix: string): Promise<PlayerApp[]> {
  const port = await conductor.attachAppInterface();
  const adminWs = conductor.adminWs();
  const players: PlayerApp[] = [];
  for (let i = 0; i < count; i++) {
    const agentPubKey = await adminWs.generateAgentPubKey();
    const installedAppId = `${labelPrefix}-${i}`;
    const appInfo = await conductor.installApp({ appBundleSource: appSource, options: { agentPubKey, installedAppId } });
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
export async function useTestCoordinators(player: PlayerApp, zomes: string[]): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const wasmDir = fileURLToPath(new URL("../../../target/test-utils/wasm32-unknown-unknown/release/", import.meta.url));
  const adminWs = player.conductor.adminWs();
  for (const zome of zomes) {
    const file = `${zome}.wasm`;
    const bytes = new Uint8Array(await readFile(`${wasmDir}${file}`));
    await adminWs.updateCoordinators({
      cell_id: player.cells[0].cell_id,
      source: { type: "bundle", value: { manifest: { zomes: [{ name: zome, hash: null, path: file, dependencies: [{ name: `${zome}_integrity` }] }] }, resources: { [file]: bytes } } },
    } as never);
  }
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
