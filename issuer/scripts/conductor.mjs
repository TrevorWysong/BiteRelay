// Runs the issuer's own Holochain conductor: always on, holding the
// issuer's agent key, on the network's bootstrap and relay servers. Its
// admin interface listens on this machine only -- the issuer service beside
// it is the one thing that talks to it.
//
//   ISSUER_DATA_DIR=/var/lib/relay-issuer \
//   ISSUER_LAIR_PASSPHRASE=... \
//   BOOTSTRAP_URL=https://bootstrap.example.org RELAY_URL=https://relay.example.org \
//   node scripts/conductor.mjs
//
// The passphrase unlocks the keystore holding the issuer's key: keep it in
// a secret store, never in the repo. The data directory holds the key and
// the issuer's chain: back it up.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} isn't set -- see the comment at the top of scripts/conductor.mjs`);
    process.exit(2);
  }
  return value;
}

const dataDir = path.resolve(required("ISSUER_DATA_DIR"));
const passphrase = required("ISSUER_LAIR_PASSPHRASE");
const bootstrapUrl = required("BOOTSTRAP_URL");
const relayUrl = required("RELAY_URL");
const adminPort = Number(process.env.CONDUCTOR_ADMIN_PORT ?? 8870);
// Holochain refuses a plaintext relay outside development: the network's
// servers are reached over TLS.
for (const [name, url] of [["BOOTSTRAP_URL", bootstrapUrl], ["RELAY_URL", relayUrl]]) {
  if (!url.startsWith("https://")) {
    console.error(`${name} must be an https:// URL -- the network's servers behind TLS (DEPLOYMENT.md).`);
    process.exit(2);
  }
}

const conductorDir = path.join(dataDir, "conductor");
// The keystore listens on a Unix socket inside it, and a socket's path has
// a hard length limit (104 bytes on macOS, 108 on Linux).
const socketPath = path.join(conductorDir, "ks", "socket");
if (Buffer.byteLength(socketPath) > 100) {
  console.error(`ISSUER_DATA_DIR is too long a path for the keystore's socket (${socketPath}). Use a shorter one, such as /var/lib/relay-issuer.`);
  process.exit(2);
}
mkdirSync(conductorDir, { recursive: true });
const configPath = path.join(dataDir, "conductor-config.yaml");
// The admin interface binds to localhost unless told otherwise
// (`danger_bind_addr`), which this never sets.
writeFileSync(
  configPath,
  `data_root_path: ${conductorDir}
keystore:
  type: lair_server_in_proc
  lair_root: ${path.join(conductorDir, "ks")}
admin_interfaces:
  - driver:
      type: websocket
      port: ${adminPort}
      allowed_origins: '*'
network:
  bootstrap_url: ${bootstrapUrl}
  relay_url: ${relayUrl}
`,
);

const holochain = spawn("holochain", ["--piped", "-c", configPath], { stdio: ["pipe", "inherit", "inherit"] });
holochain.stdin.end(passphrase);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => holochain.kill(signal));
holochain.on("exit", (code) => process.exit(code ?? 1));
