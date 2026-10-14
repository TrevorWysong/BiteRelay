// The persistent local dev conductor: fixed data directory (.dev/conductor),
// fixed admin port, its own bootstrap/relay server -- so identities, stores
// and orders survive restarts, unlike the throwaway Tryorama conductor this
// replaces (which ran in a temp dir and started empty every time).
//
//   npm run dev:conductor          start (reusing existing data)
//   npm run dev:reset              wipe all dev data, start fresh, then seed
//
// Flags: --reset (wipe .dev/conductor first, stopping a running instance),
// --seed (run scripts/seed.mjs once the conductor is ready).
//
// Conductor/bootstrap logs go to .dev/conductor.log; only what you need is
// printed here. Ctrl+C stops both processes.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_PORT,
  ADMIN_URL,
  BOOTSTRAP_PORT,
  CONDUCTOR_CONFIG,
  CONDUCTOR_DIR,
  DEV_DIR,
  DNA_PATH,
  LAIR_PASSPHRASE,
  PID_FILE,
  dnaHashOf,
  hashB64,
  relayCells,
  readDevNetwork,
  DEV_NETWORK,
  tryConnectAdmin,
} from "./lib/devEnv.mjs";

const LOG_FILE = path.join(DEV_DIR, "conductor.log");
const READY_TIMEOUT_MS = 60_000;
const args = new Set(process.argv.slice(2));

/// Same network tuning Tryorama uses for local runs (fast gossip, local
/// bootstrap/relay), but with a fixed data root and admin port.
function conductorConfig() {
  return `data_root_path: ${CONDUCTOR_DIR}
keystore:
  type: lair_server_in_proc
  lair_root: ${path.join(CONDUCTOR_DIR, "ks")}
admin_interfaces:
  - driver:
      type: websocket
      port: ${ADMIN_PORT}
      allowed_origins: '*'
network:
  bootstrap_url: http://127.0.0.1:${BOOTSTRAP_PORT}/
  relay_url: http://127.0.0.1:${BOOTSTRAP_PORT}/
  target_arc_factor: 1
  advanced:
    k2Gossip:
      initiateIntervalMs: 3000
      minInitiateIntervalMs: 3000
      initiateJitterMs: 1000
      roundTimeoutMs: 5000
    irohTransport:
      relayAllowPlainText: true
`;
}

/// Resolves once `pattern` appears in the process's output; rejects if it
/// exits first or takes longer than READY_TIMEOUT_MS.
function waitForOutput(child, pattern, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not become ready within ${READY_TIMEOUT_MS / 1000}s (see ${LOG_FILE})`)), READY_TIMEOUT_MS);
    const onData = (chunk) => {
      if (pattern.test(chunk.toString())) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited (code ${code}) before becoming ready (see ${LOG_FILE})`));
    });
  });
}

/// Stops an instance started by this script elsewhere (via its pid file)
/// and waits until its admin port stops answering.
async function stopRunningInstance() {
  if (!existsSync(PID_FILE)) return;
  const pid = Number(readFileSync(PID_FILE, "utf8"));
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  for (let i = 0; i < 40; i++) {
    const ws = await tryConnectAdmin();
    if (!ws) return;
    await ws.client.close();
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`conductor (pid ${pid}) did not stop; stop it manually and retry`);
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/// One line per identity group: which DNA each installed identity runs, and
/// whether that's the DNA `npm run backend` last built.
async function printStatus() {
  const adminWs = await tryConnectAdmin();
  if (!adminWs) return;
  try {
    const cells = await relayCells(adminWs);
    const built = existsSync(DNA_PATH) ? dnaHashOf(DNA_PATH) : null;
    // The seeded network's DNA carries its issuer in its properties, so its
    // hash differs from the bare build's: an identity is current if it's on
    // that network and the build hasn't changed since it was set up.
    const network = readDevNetwork();
    const current = network ? (network.builtDna === built ? network.dnaHash : null) : built;
    const stale = cells.filter((c) => built && hashB64(c.cellId[0]) !== current).length;
    console.log(`  Identities on this conductor: ${cells.length}${stale ? ` (${stale} on an older DNA -- run \`npm run dev:reset\` to start fresh)` : ""}`);
  } finally {
    await adminWs.client.close();
  }
}

async function main() {
  if (args.has("--reset")) {
    await stopRunningInstance();
    rmSync(CONDUCTOR_DIR, { recursive: true, force: true });
    // Its issuer was on the wiped conductor: the seed makes a new network.
    rmSync(DEV_NETWORK, { force: true });
    console.log("Dev data wiped.");
  } else {
    const existing = await tryConnectAdmin();
    if (existing) {
      await existing.client.close();
      console.log(`A conductor is already running at ${ADMIN_URL}.`);
      return;
    }
  }

  mkdirSync(CONDUCTOR_DIR, { recursive: true });
  writeFileSync(CONDUCTOR_CONFIG, conductorConfig());
  const log = createWriteStream(LOG_FILE, { flags: "a" });

  const bootstrap = spawn("kitsune2-bootstrap-srv", ["--listen", `127.0.0.1:${BOOTSTRAP_PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  const holochain = spawn("holochain", ["--piped", "-c", CONDUCTOR_CONFIG], { stdio: ["pipe", "pipe", "pipe"] });
  for (const child of [bootstrap, holochain]) {
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
  }

  let shuttingDown = false;
  async function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nStopping conductor...");
    await Promise.all([stopChild(holochain), stopChild(bootstrap)]);
    if (existsSync(PID_FILE) && readFileSync(PID_FILE, "utf8") === String(process.pid)) unlinkSync(PID_FILE);
    log.end();
    process.exit(code);
  }
  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));

  try {
    await waitForOutput(bootstrap, /#kitsune2_bootstrap_srv#listening#/, "bootstrap server");
    holochain.stdin.end(LAIR_PASSPHRASE);
    await waitForOutput(holochain, /Conductor ready\./, "conductor");
  } catch (err) {
    console.error(err.message);
    await shutdown(1);
  }
  // From here on, either process dying takes the other down with it.
  for (const [child, label] of [[bootstrap, "bootstrap server"], [holochain, "conductor"]]) {
    child.once("exit", (code) => {
      if (shuttingDown) return;
      console.error(`${label} exited unexpectedly (code ${code}); see ${LOG_FILE}`);
      shutdown(1);
    });
  }
  writeFileSync(PID_FILE, String(process.pid));

  console.log("================================================================");
  console.log(`  Dev conductor ready. Admin URL:  ${ADMIN_URL}`);
  console.log(`  Data: ${CONDUCTOR_DIR}  (survives restarts)`);
  await printStatus();
  console.log("  Ctrl+C stops it.");
  console.log("================================================================");

  if (args.has("--seed")) {
    const seed = spawn(process.execPath, [fileURLToPath(new URL("./seed.mjs", import.meta.url))], { stdio: "inherit" });
    seed.once("exit", (code) => code !== 0 && console.error(`seed exited with code ${code}`));
  }
}

main();
