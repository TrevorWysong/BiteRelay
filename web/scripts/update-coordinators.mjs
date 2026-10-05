// Pushes freshly-built coordinator wasm into an already-installed, already-
// running conductor -- no `hc dna pack`/`hc app pack`, no reinstall, no
// conductor restart. This is Holochain's own `AdminRequest::UpdateCoordinators`
// (already shipping in the 0.7.0 we're on, not something ahead on the
// roadmap): coordinator zomes were never part of a DNA's hash to begin with
// (see `force_order_update_for_testing`'s own doc comment in
// dispatch/coordinator/src/orders.rs for why), so the conductor can swap in
// new coordinator wasm for a cell it's already running without touching
// anything that would require re-genesis.
//
// Only covers coordinator-zome changes (the vast majority of changes to this
// codebase -- see the integrity/coordinator split throughout). An integrity
// zome change (a `validate()` rule, an entry/link type) changes the DNA hash
// by definition and still needs the full `cargo build --release` -> `hc dna
// pack` -> `hc app pack` -> reinstall path; this script will not help there.
//
// Usage (from web/): node scripts/update-coordinators.mjs <adminUrl>
// <adminUrl> is the same URL run-conductor.mjs prints / onboarding asks for.
// Run `cargo build --release --target wasm32-unknown-unknown` first -- this
// script only pushes whatever's already sitting in target/wasm32-unknown-
// unknown/release, it doesn't build anything itself.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AdminWebsocket, CellType } from "@holochain/client";

const ROLE_NAME = "relay"; // mirrors web/src/holochain/admin.ts's ROLE_NAME

// The coordinator half of dnas/relay/workdir/dna.yaml's zome list -- kept in
// sync with it by hand (an 8-entry list that only grows when a whole new
// zome is added, not on every ordinary change) rather than parsing the YAML,
// which would need a parser dependency for one small, slow-changing file.
const COORDINATOR_ZOMES = [
  { name: "profiles", integrity: "profiles_integrity" },
  { name: "catalog", integrity: "catalog_integrity" },
  { name: "geo_presence", integrity: "geo_presence_integrity" },
  { name: "dispatch", integrity: "dispatch_integrity" },
  { name: "attestation", integrity: "attestation_integrity" },
  { name: "ledger", integrity: "ledger_integrity" },
  { name: "reputation", integrity: "reputation_integrity" },
  { name: "dispute", integrity: "dispute_integrity" },
];

const WASM_DIR = fileURLToPath(new URL("../../target/wasm32-unknown-unknown/release/", import.meta.url));

/// Builds the wire shape `UpdateCoordinators` expects for `source: { type:
/// "bundle", value: ... }` -- a plain `{ manifest, resources }` object, not a
/// packed `.coordinators` *file* (that's a separate, filesystem-only path
/// via `source: { type: "path", value: "..." }`, and there's no `hc`
/// subcommand yet to produce one -- this bundle shape is just Rust's own
/// `#[derive(Serialize)]` on `mr_bundle::Bundle<CoordinatorManifest>`, so
/// building it directly as JSON/msgpack is the framework's own wire format,
/// not something invented here). One zome per bundle, not all of them in
/// one call -- found the hard way: bundling all 8 zomes' wasm together
/// (~30MB) silently kills the admin websocket connection mid-request
/// (`ClientClosedWithPendingRequests`, close code 1006), while a single
/// zome's wasm (a few MB) goes through cleanly every time. `updateCoordinators`
/// already merges by zome name ("replaces any installed coordinator zomes
/// with the same zome name"), so there's no correctness cost to sending
/// them one at a time -- only a reliability win.
async function buildSingleZomeBundle(name, integrity) {
  const fileName = `${name}.wasm`;
  const wasmPath = new URL(fileName, `file://${WASM_DIR}`);
  let bytes;
  try {
    bytes = await readFile(wasmPath);
  } catch {
    throw new Error(`missing ${fileName} in ${WASM_DIR} -- run cargo build --release --target wasm32-unknown-unknown first`);
  }
  const zome = { name, hash: null, path: fileName, dependencies: [{ name: integrity }] };
  return { manifest: { zomes: [zome] }, resources: { [fileName]: new Uint8Array(bytes) } };
}

function provisionedRelayCellIds(appInfo) {
  const cellInfos = appInfo.cell_info[ROLE_NAME] ?? [];
  return cellInfos.filter((c) => c.type === CellType.Provisioned).map((c) => c.value.cell_id);
}

async function main() {
  const adminUrl = process.argv[2];
  if (!adminUrl) {
    console.error("Usage: node scripts/update-coordinators.mjs <adminUrl>");
    process.exit(1);
  }

  // A plain Node `ws` connection sends no Origin header at all unless told
  // to -- the admin interface's `AllowedOrigins::Any` still requires *an*
  // Origin header to be present, just not any specific value. Same fix as
  // admin.ts's own `provisionNewIdentity` doc comment already explains.
  const adminWs = await AdminWebsocket.connect({ url: new URL(adminUrl), wsClientOptions: { origin: "http://localhost" } });
  try {
    const apps = await adminWs.listApps({});
    const cellIds = apps.flatMap(provisionedRelayCellIds);
    if (cellIds.length === 0) {
      console.log(`No installed "${ROLE_NAME}" cells found on this conductor -- nothing to update.`);
      return;
    }

    for (const cellId of cellIds) {
      const label = Buffer.from(cellId[1]).toString("base64").slice(0, 12);
      for (const { name, integrity } of COORDINATOR_ZOMES) {
        const bundle = await buildSingleZomeBundle(name, integrity);
        await adminWs.updateCoordinators({ cell_id: cellId, source: { type: "bundle", value: bundle } });
      }
      console.log(`Updated all coordinator zomes for cell ${label}...`);
    }
    console.log(`\nDone -- ${cellIds.length} cell(s) updated. Existing browser tabs keep working, no refresh needed for the backend change itself.`);
  } finally {
    adminWs.client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
