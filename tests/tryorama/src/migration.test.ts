// Proves moving an account to the next version of the network (MIGRATION.md),
// across two real networks: the same DNA under two seeds stands in for the
// old version and the new. On the old network an account seals its private
// details to its key on the new one, records the move and closes its chain
// -- after which Holochain accepts nothing more from it there. An issuer
// on both networks credits what the closed ledger held to the new key.
// The new app, carrying the old network as its `previous` role, arrives:
// it opens the parcel, brings the account's store over, and counts its
// history -- each checked on the old network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dhtSync, enableAndGetAgentApp, runScenario, type CallableCell, type Conductor, type PlayerApp } from "@holochain-open-dev/tryorama";
import { encodeHashToBase64, type AgentPubKey, type Record as HcRecord } from "@holochain/client";
import { EMPTY_HANDS, HAPP_PATH, shareAgentsOn, ST_PETE, TEST_PROPERTIES, actionHash, decodeEntry, latestLedgerEntry, retryUntil, retryUntilOk, useTestCoordinators, retryingCaller } from "./helpers.js";

const DNA_PATH = fileURLToPath(new URL("../../../dnas/relay/workdir/relay.dna", import.meta.url));
const OLD = "relay-v1";
const NEW = "relay-v2";

/// The next version's app: its own network, and the previous one as its
/// `previous` role.
function twoNetworkHapp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-next-"));
  const role = (name: string) => ({ name, provisioning: { strategy: "create", deferred: false }, dna: { path: DNA_PATH, modifiers: { network_seed: null, properties: null }, clone_limit: 0 } });
  writeFileSync(path.join(dir, "happ.yaml"), JSON.stringify({ manifest_version: "0", name: "relay-next", description: null, roles: [role("relay"), role("previous")] }));
  execFileSync("hc", ["app", "pack", dir, "-o", path.join(dir, "relay-next.happ")]);
  return path.join(dir, "relay-next.happ");
}

const settings = (seed: string, properties: Record<string, unknown>) => ({ type: "provisioned" as const, value: { membrane_proof: undefined, modifiers: { network_seed: seed, properties: { ...TEST_PROPERTIES, ...properties } } } });

/// Installs an app for `agent` on `conductor`, as a player.
async function install(conductor: Conductor, agent: AgentPubKey, happ: string, rolesSettings: Record<string, unknown>, appId: string): Promise<PlayerApp> {
  const port = await conductor.attachAppInterface();
  const adminWs = conductor.adminWs();
  const appInfo = await conductor.installApp({ appBundleSource: { type: "path", value: happ }, options: { agentPubKey: agent, installedAppId: appId, rolesSettings } } as never);
  const issued = await adminWs.issueAppAuthenticationToken({ installed_app_id: appInfo.installed_app_id });
  const appWs = await conductor.connectAppWs(issued.token, port);
  const agentApp = await enableAndGetAgentApp(adminWs, appWs, appInfo);
  return { conductor, appWs, ...agentApp };
}

await runScenario(async (scenario) => {
  const [issuerHost, aliceHost, bobHost] = [await scenario.addConductor(), await scenario.addConductor(), await scenario.addConductor()];
  const [issuerKey, aliceKey, bobKey] = [await issuerHost.adminWs().generateAgentPubKey(), await aliceHost.adminWs().generateAgentPubKey(), await bobHost.adminWs().generateAgentPubKey()];
  const properties = { issuers: [encodeHashToBase64(issuerKey)], credit_limit_cents: 0 };
  const next = twoNetworkHapp();

  // The old network: the issuer and Alice. The new: the issuer, and Bob --
  // Alice's account on the new version, whose app carries the old network
  // too.
  const issuerOld = await install(issuerHost, issuerKey, HAPP_PATH, { relay: settings(OLD, properties) }, "issuer-old");
  const alice = await install(aliceHost, aliceKey, HAPP_PATH, { relay: settings(OLD, properties) }, "alice-old");
  const issuerNew = await install(issuerHost, issuerKey, HAPP_PATH, { relay: settings(NEW, properties) }, "issuer-new");
  const bob = await install(bobHost, bobKey, next, { relay: settings(NEW, properties), previous: settings(OLD, properties) }, "bob-next");

  const oldNetwork = issuerOld.cells[0].cell_id[0];
  const newNetwork = issuerNew.cells[0].cell_id[0];
  const bobHere = bob.namedCells.get("relay")!;
  const bobPrevious = bob.namedCells.get("previous")!;
  assert.ok(Buffer.from(bobHere.cell_id[0]).equals(Buffer.from(newNetwork)) && Buffer.from(bobPrevious.cell_id[0]).equals(Buffer.from(oldNetwork)), "two networks, as the versions would be");
  await shareAgentsOn([issuerHost, aliceHost, bobHost], oldNetwork);
  await shareAgentsOn([issuerHost, bobHost], newNetwork);
  const syncOld = () => dhtSync([issuerOld, alice, { ...bob, cells: [bobPrevious] }], oldNetwork);
  const syncNew = () => dhtSync([issuerNew, { ...bob, cells: [bobHere] }], newNetwork);
  const on = (cell: CallableCell, zome: string) => retryingCaller(cell, zome);
  for (const [player, cell] of [[alice, alice.cells[0]], [bob, bobHere]] as const) await useTestCoordinators(player, ["account", "catalog", "ledger"], cell);

  // ===== On the old network: funds and a store =====
  await on(issuerOld.cells[0], "ledger")("issue_grant", { to: aliceKey, amount: 3000, reference: "alice-1" });
  await syncOld();
  await retryUntilOk(() => on(alice.cells[0], "ledger")<number>("collect_grants", null).then((n) => (n > 0 ? n : Promise.reject(new Error("not yet")))));
  const store = actionHash(await on(alice.cells[0], "catalog")<HcRecord>("publish_catalog", { business_name: "Alice's Bakery", location: ST_PETE }));
  await on(alice.cells[0], "catalog")("add_menu_item", { catalog_ref: store, name: "Sourdough", price_cents: 700, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [], modifier_groups: [], tax_category: "" });

  // ===== Moving out: refused while anything would be stranded =====
  const migrate = { network: newNetwork, successor: bobKey, issuer: issuerKey, parcel: JSON.stringify({ name: "Alice" }) };
  await assert.rejects(on(alice.cells[0], "account")("migrate_out", migrate), /listings down first/, "a listed store's stake would be stranded");
  await on(alice.cells[0], "catalog")("close_listing", store);
  await assert.rejects(on(alice.cells[0], "account")("migrate_out", { ...migrate, network: oldNetwork }), /moves to the next one/, "not to the same network");
  await assert.rejects(on(alice.cells[0], "account")("create_raw_migration_for_testing", { network: oldNetwork, successor: bobKey }), /another network/, "nor forged so");
  await on(alice.cells[0], "account")("migrate_out", migrate);
  await assert.rejects(on(alice.cells[0], "ledger")("cash_out", { issuer: issuerKey, amount: 1000, instructions: "" }), /moved to the new version/, "the old key can't spend here any more");
  const latest = await latestLedgerEntry(alice);
  await assert.rejects(
    on(alice.cells[0], "ledger")("create_raw_ledger_entry_for_testing", { kind: { Redeem: { issuer: issuerKey, instructions: null } }, amount: 1000, balance: 2000, in_hand: EMPTY_HANDS, previous: latest.hash }),
    // Since 0.7.1 the author's own conductor refuses any action after the
    // close before the ledger's own check runs; either refusal will do.
    /chain is closed|after a chain close/,
    "nor can a modified app: its ledger is closed with its chain",
  );
  assert.equal(await on(alice.cells[0], "ledger")<number>("get_balance", aliceKey), 3000, "and what it held stays exactly as it was");
  console.log("[PASS] an account moves out once, nothing stranded, and its chain closes");

  // ===== The issuer carries the balance =====
  await syncOld();
  const [request] = await retryUntil(
    () => on(issuerOld.cells[0], "account")<{ requests: { account: Uint8Array; successor: Uint8Array; network: Uint8Array; close: Uint8Array | null }[] }>("get_migration_requests", { after: null }).then((p) => p.requests),
    (r) => r.length === 1 && !!r[0].close,
  );
  assert.ok(Buffer.from(request.successor).equals(Buffer.from(bobKey)) && Buffer.from(request.network).equals(Buffer.from(newNetwork)));
  const standing = await on(issuerOld.cells[0], "ledger")<{ balance: number }>("standing_at", { agent: aliceKey, head: request.close });
  assert.equal(standing.balance, 3000, "what the ledger held at the close");
  await on(issuerNew.cells[0], "ledger")("issue_grant", { to: bobKey, amount: standing.balance, reference: `migration:${encodeHashToBase64(aliceKey)}` });
  await syncNew();
  await retryUntilOk(() => on(bobHere, "ledger")<number>("collect_grants", null).then((n) => (n > 0 ? n : Promise.reject(new Error("not yet")))));
  assert.equal(await on(bobHere, "ledger")<number>("get_balance", bobKey), 3000, "credited, on the new network, to the new key");
  console.log("[PASS] an issuer on both networks carries the closed balance over");

  // ===== Arriving: the parcel, the store, the history =====
  assert.deepEqual(await on(bobPrevious, "account")<string[]>("open_parcels", null), [JSON.stringify({ name: "Alice" })], "the new key opens what only the old one could read");
  assert.ok(Buffer.from(await on(bobHere, "account")<Uint8Array>("arrive", null)).equals(Buffer.from(aliceKey)), "it arrives as the account it was");
  const was = await on(bobHere, "account")<Uint8Array | null>("arrived_from", bobKey);
  assert.ok(was && Buffer.from(was).equals(Buffer.from(aliceKey)), "checked on the previous network");
  assert.equal(await on(issuerNew.cells[0], "account")<Uint8Array | null>("arrived_from", bobKey), null, "an app without the previous network can't vouch for it");
  await assert.rejects(on(bobHere, "account")("create_raw_arrival_for_testing", { previous_network: newNetwork, previous_account: aliceKey, migration: request.close }), /another network/, "an arrival comes from another network");

  const stores = await on(bobHere, "catalog")<{ original_action: Uint8Array }[]>("previous_stores", null);
  assert.equal(stores.length, 1);
  const imported = await on(bobHere, "catalog")<Uint8Array>("import_store", store);
  assert.deepEqual(await on(bobHere, "catalog")<Uint8Array>("import_store", store), imported, "safe to repeat");
  const [item] = (await on(bobHere, "catalog")<{ items: { record: HcRecord }[] }>("list_menu_items", { catalog_ref: imported, after: null })).items.map((v) => decodeEntry<{ name: string; price_cents: number }>(v.record));
  assert.deepEqual([item.name, item.price_cents], ["Sourdough", 700], "the menu comes over");
  const from = await on(bobHere, "catalog")<Uint8Array | null>("imported_from", imported);
  assert.ok(from && Buffer.from(from).equals(Buffer.from(store)), "and the store's history with it");
  await on(bobHere, "reputation")("get_rating_summary", { Store: imported });
  console.log("[PASS] the new key arrives: details, store and history, each checked on the old network");
});
