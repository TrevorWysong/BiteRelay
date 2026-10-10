// Builds the app as Holochain runtimes install it -- deploy/relay.webhapp,
// the production hApp plus its production UI -- for a network whose DNA
// properties are in deploy/properties.json (see deploy/properties.example.json
// and DEPLOYMENT.md).
//
//   npm run package -- --network-seed relay-2026 \
//     [--bootstrap-url https://bootstrap.example.org --relay-url https://relay.example.org]
//
// The bootstrap and relay URLs are the network's own servers (see
// DEPLOYMENT.md); without them, runtimes use their defaults.
//
// Everyone on a network must install the same bundle: the properties and
// network seed are part of the DNA hash, so a different value is a
// different, separate network.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO, DNA_PATH } from "./lib/devEnv.mjs";

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const networkSeed = option("--network-seed");
const bootstrapUrl = option("--bootstrap-url");
const relayUrl = option("--relay-url");
if (!args.includes("--network-seed") || !networkSeed) {
  fail("Pass --network-seed <name>: it names the network this bundle joins.");
}

const propertiesPath = path.join(REPO, "deploy/properties.json");
if (!existsSync(propertiesPath)) fail("deploy/properties.json is missing -- copy deploy/properties.example.json and fill it in.");
const properties = JSON.parse(readFileSync(propertiesPath, "utf8"));

// Money: a network states how far into debt anyone may go (0 recommended:
// everything prepaid, so a fresh identity can't order on credit), and who
// may issue funds -- without an issuer, nobody with a 0 limit could ever
// have any. See relay_governance.
if (!Number.isInteger(properties.credit_limit_cents) || properties.credit_limit_cents < 0) {
  fail("deploy/properties.json needs credit_limit_cents: how far below zero any balance may go (0 = everything prepaid, recommended).");
}
if (!Array.isArray(properties.issuers) || properties.issuers.some((key) => !/^uhCAk[A-Za-z0-9_-]{48}$/.test(key))) {
  fail("deploy/properties.json needs issuers: the agent keys (uhCAk...) of whoever credits accounts against real payments.");
}
if (properties.credit_limit_cents === 0 && properties.issuers.length === 0) {
  fail("With credit_limit_cents 0 and no issuers, nobody could ever have funds -- name at least one issuer.");
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function step(label, cmd, cmdArgs, cwd = REPO) {
  console.log(`\n▸ ${label}`);
  execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit", env: { ...process.env, VITE_RELAY_DEV_HOST: "false" } });
}

const work = mkdtempSync(path.join(tmpdir(), "relay-package-"));
try {
  step("Building zomes", "cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"]);
  step("Packing DNA", "hc", ["dna", "pack", "dnas/relay/workdir"]);

  // The hApp, with this network's properties and seed. JSON is YAML.
  const role = {
    name: "relay",
    provisioning: { strategy: "create", deferred: false },
    dna: { path: DNA_PATH, modifiers: { properties, network_seed: networkSeed }, clone_limit: 0 },
  };
  const manifest = { manifest_version: "0", name: "relay", description: "Relay -- food delivery with no middleman, on Holochain", roles: [role], bootstrap_url: bootstrapUrl ?? null, relay_url: relayUrl ?? null };
  writeFileSync(path.join(work, "happ.yaml"), JSON.stringify(manifest, null, 2));
  step("Packing hApp", "hc", ["app", "pack", work]);

  // The production UI: no dev host, so no Admin API code (see
  // src/holochain/host.ts), and none of the dev-only public files.
  step("Building the UI", "npm", ["run", "build"], path.join(REPO, "web"));
  const dist = path.join(REPO, "web/dist");
  for (const devOnly of ["relay.happ", "sw.js"]) rmSync(path.join(dist, devOnly), { force: true });
  step("Zipping the UI", "zip", ["-q", "-r", path.join(work, "ui.zip"), "."], dist);

  writeFileSync(path.join(work, "web-happ.yaml"), JSON.stringify({ manifest_version: "0", name: "relay", ui: { path: "./ui.zip" }, happ: { path: "./relay.happ" } }, null, 2));
  const out = path.join(REPO, "deploy/relay.webhapp");
  step("Packing the web hApp", "hc", ["web-app", "pack", work, "-o", out]);

  console.log(`\n✓ ${path.relative(REPO, out)} (${Math.round(statSync(out).size / 1024)} KB)`);
  console.log(`  network seed: ${networkSeed}`);
  console.log(`  arbitrators:  ${properties.arbitrators.length}`);
  console.log(`  issuers:      ${properties.issuers.length}`);
  console.log(`  credit limit: ${properties.credit_limit_cents} cents`);
  console.log(`  bootstrap:    ${bootstrapUrl ?? "(runtime default)"}`);
  console.log(`  relay:        ${relayUrl ?? "(runtime default)"}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
