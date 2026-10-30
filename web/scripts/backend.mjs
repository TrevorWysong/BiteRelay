// One command for every backend change: build the zomes, pack the DNA and
// hApp, publish the bundle the UI installs from, and update the running dev
// conductor -- so there's no "which step did I forget" left to get wrong.
//
//   npm run backend
//
// What it does to a running conductor depends on what changed, decided by
// comparing the freshly packed DNA's hash with the DNA each installed
// identity actually runs:
//   - same DNA (only coordinator code changed): hot-swaps the new
//     coordinators into every identity -- no restart, no data loss;
//   - different DNA (integrity changed: entry/link types or validation):
//     coordinators can't be swapped onto a DNA they weren't built for, so
//     it says so and points at `npm run dev:reset`.
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { BUILT_HAPP, DNA_PATH, REPO, SERVED_HAPP, dnaHashOf, hashB64, readDevNetwork, handShakeCells, tryConnectAdmin } from "./lib/devEnv.mjs";
import { updateCoordinators } from "./lib/coordinators.mjs";

function step(label, cmd, cmdArgs) {
  console.log(`\n▸ ${label}`);
  execFileSync(cmd, cmdArgs, { cwd: REPO, stdio: "inherit" });
}

/// The DNA the dev network's identities run, if it's this build's: the seed
/// installs everyone with the network's properties (its issuer roster),
/// which gives a different hash from the bare build's. Recorded beside it in
/// web/public/dev-network.json.
function devNetworkDna(builtDna) {
  const network = readDevNetwork();
  return network?.builtDna === builtDna ? network.dnaHash : null;
}

function sameBytes(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

async function main() {
  step("Building zomes", "cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"]);
  step("Generating TS types", "cargo", ["run", "--quiet", "--manifest-path", "tools/typegen/Cargo.toml"]);
  step("Packing DNA", "hc", ["dna", "pack", "dnas/handshake/workdir"]);
  step("Packing hApp", "hc", ["app", "pack", "workdir"]);

  const dnaHash = dnaHashOf(DNA_PATH);
  if (sameBytes(BUILT_HAPP, SERVED_HAPP)) {
    console.log("\n▸ web/public/handshake.happ already up to date");
  } else {
    copyFileSync(BUILT_HAPP, SERVED_HAPP);
    console.log("\n▸ Published workdir/handshake.happ -> web/public/handshake.happ (new identities install this)");
  }
  console.log(`  DNA hash: ${dnaHash}`);

  const adminWs = await tryConnectAdmin();
  if (!adminWs) {
    console.log("\nNo dev conductor running -- start it with `npm run dev:conductor`. Nothing else to update.");
    return;
  }
  try {
    const cells = await handShakeCells(adminWs);
    const runnable = new Set([dnaHash, devNetworkDna(dnaHash)].filter(Boolean));
    const current = cells.filter((c) => runnable.has(hashB64(c.cellId[0])));
    const stale = cells.filter((c) => !runnable.has(hashB64(c.cellId[0])));
    if (current.length > 0) {
      const zomeCount = await updateCoordinators(adminWs, current.map((c) => c.cellId));
      console.log(`\n▸ Hot-swapped ${zomeCount} coordinator zomes into ${current.length} running identit${current.length === 1 ? "y" : "ies"}. No reload needed.`);
    }
    if (stale.length > 0) {
      console.log(`\n⚠ ${stale.length} identit${stale.length === 1 ? "y runs" : "ies run"} an older DNA (integrity zomes or DNA settings changed), so they can't run this build.`);
      console.log("  Run `npm run dev:reset` to wipe dev data, restart the conductor on this build, and re-seed.");
    }
    if (cells.length === 0) console.log("\nConductor has no identities yet -- `npm run seed` creates a demo world.");
  } finally {
    await adminWs.client.close();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message ?? err}`);
  process.exit(1);
});
