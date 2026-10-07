// The local dev environment's fixed facts -- where the persistent conductor
// keeps its data, which ports it listens on, where the built bundle lives --
// shared by every dev script so they can't drift apart. Override the ports
// with RELAY_ADMIN_PORT / RELAY_BOOTSTRAP_PORT if they clash locally.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdminWebsocket, CellType, encodeHashToBase64 } from "@holochain/client";

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));
export const DEV_DIR = path.join(REPO, ".dev");
export const CONDUCTOR_DIR = path.join(DEV_DIR, "conductor");
export const CONDUCTOR_CONFIG = path.join(CONDUCTOR_DIR, "conductor-config.yaml");
export const PID_FILE = path.join(DEV_DIR, "conductor.pid");

export const ADMIN_PORT = Number(process.env.RELAY_ADMIN_PORT ?? 8870);
export const BOOTSTRAP_PORT = Number(process.env.RELAY_BOOTSTRAP_PORT ?? 8871);
export const ADMIN_URL = `ws://localhost:${ADMIN_PORT}`;

/// Built by `npm run backend`; the UI installs new identities from the copy
/// in web/public, and the seed script installs from that same copy.
export const DNA_PATH = path.join(REPO, "dnas/relay/workdir/relay.dna");
export const BUILT_HAPP = path.join(REPO, "workdir/relay.happ");
export const SERVED_HAPP = path.join(REPO, "web/public/relay.happ");

/// Mirrors web/src/holochain/admin.ts's ROLE_NAME.
export const ROLE_NAME = "relay";

/// A dev-only keystore passphrase -- this conductor never holds real keys.
export const LAIR_PASSPHRASE = "relay-dev";

/// Node's `ws` sends no Origin header unless told to, and the admin
/// interface's `allowed_origins: "*"` still requires one to be present.
export const WS_OPTIONS = { origin: "http://localhost" };

export async function connectAdmin() {
  return AdminWebsocket.connect({ url: new URL(ADMIN_URL), wsClientOptions: WS_OPTIONS, defaultTimeout: 60_000 });
}

/// `null` when no conductor is answering on ADMIN_URL.
export async function tryConnectAdmin() {
  try {
    return await connectAdmin();
  } catch {
    return null;
  }
}

export function dnaHashOf(dnaPath) {
  return execFileSync("hc", ["dna", "hash", dnaPath], { encoding: "utf8" }).trim();
}

/// Every provisioned `relay` cell on the conductor, with the app it belongs to.
export async function relayCells(adminWs) {
  const apps = await adminWs.listApps({});
  return apps.flatMap((app) =>
    (app.cell_info[ROLE_NAME] ?? [])
      .filter((c) => c.type === CellType.Provisioned)
      .map((c) => ({ appId: app.installed_app_id, cellId: c.value.cell_id })),
  );
}

/// Reuses an already-attached, app-agnostic interface rather than opening a
/// new port each run -- interfaces persist across restarts (mirrors
/// web/src/holochain/admin.ts's appInterfacePort).
export async function appInterfacePort(adminWs) {
  const shared = (await adminWs.listAppInterfaces()).find((i) => i.allowed_origins === "*" && !i.installed_app_id);
  if (shared) return shared.port;
  return (await adminWs.attachAppInterface({ allowed_origins: "*" })).port;
}

/// The same `uhC0k...` form `hc dna hash` prints.
export function hashB64(hash) {
  return encodeHashToBase64(hash);
}
