// Pushes freshly-built coordinator wasm into already-installed, running
// cells -- Holochain's own `AdminRequest::UpdateCoordinators`. Coordinator
// zomes aren't part of a DNA's hash, so the conductor can swap them for a
// running cell without re-genesis. Only valid for cells whose *integrity*
// matches the new build: callers must check the cell's DNA hash against the
// freshly packed DNA first (see backend.ts), or new coordinator code would
// run against entry/link types it wasn't compiled for.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdminWebsocket, CellId, CoordinatorBundle } from "@holochain/client";
import { REPO } from "./devEnv.ts";

const DNA_MANIFEST = path.join(REPO, "dnas/handshake/workdir/dna.yaml");
const WASM_DIR = path.join(REPO, "target/wasm32-unknown-unknown/release");

/// `[{ name, integrity }]` for every coordinator zome in dna.yaml -- read
/// from the manifest rather than a hand-kept list, so adding a zome needs
/// no change here. The manifest's shape is fixed by `hc` (a `coordinator:`
/// block of `- name:` entries each with one `dependencies: - name:`), which
/// is all this parses.
export async function coordinatorZomes() {
  const text = await readFile(DNA_MANIFEST, "utf8");
  const block = text.slice(text.indexOf("\ncoordinator:"));
  const zomes = [...block.matchAll(/^ {4}- name: (\S+)\n(?:.*\n)*? {8}- name: (\S+)$/gm)].map((m) => ({ name: m[1], integrity: m[2] }));
  if (zomes.length === 0) throw new Error(`no coordinator zomes found in ${DNA_MANIFEST}`);
  return zomes;
}

/// One zome per request, not all of them bundled: a single ~30MB bundle of
/// every zome's wasm was found to drop the admin websocket mid-request
/// (`ClientClosedWithPendingRequests`), while one zome (a few MB) goes
/// through reliably. `updateCoordinators` merges by zome name, so sending
/// them one at a time is equivalent.
async function singleZomeBundle({ name, integrity }: { name: string; integrity: string }): Promise<CoordinatorBundle> {
  const file = `${name}.wasm`;
  const bytes = await readFile(path.join(WASM_DIR, file));
  return { manifest: { zomes: [{ name, path: file, dependencies: [{ name: integrity }] }] }, resources: { [file]: new Uint8Array(bytes) } };
}

export async function updateCoordinators(adminWs: AdminWebsocket, cellIds: CellId[]): Promise<number> {
  const zomes = await coordinatorZomes();
  const bundles = await Promise.all(zomes.map(singleZomeBundle));
  for (const cellId of cellIds) {
    for (const bundle of bundles) {
      await adminWs.updateCoordinators({ cell_id: cellId, source: { type: "bundle", value: bundle } });
    }
  }
  return zomes.length;
}
