// Identity provisioning against a real conductor's Admin API -- this is
// what "molded with Holochain in mind" means concretely: there is no
// central signup server anywhere in this app. Creating an account IS
// generating a fresh Ed25519 agent keypair and installing a genuinely
// independent cell for it on whatever conductor the browser points at.
// Multiple browser tabs/profiles pointed at the same conductor become
// multiple real, independent p2p participants on the same DHT -- that's
// the actual demo, not a simulation of one.
//
// `client.ts` deliberately treats "how do I get a token" as out-of-band;
// this module is that out-of-band step, done from the browser itself
// rather than requiring a CLI dance before every session.
import { AdminWebsocket, CellType, encodeHashToBase64 } from "@holochain/client";
import type { AgentPubKey, AppAuthenticationToken, AppInfo, CellId, InstalledAppId, WsClientOptions } from "@holochain/client";

const ROLE_NAME = "handshake";

/// A zome call needs to be *signed*, and a browser has no direct access to
/// lair-keystore to do that -- `authorizeSigningCredentials` is what makes
/// `callZome` work at all from here: it generates a keypair client-side,
/// grants it as an authorized signer for this specific cell via the admin
/// API, and registers the credentials so every subsequent zome call on this
/// cell signs with it automatically. Skipping this step is exactly why a
/// freshly-provisioned identity's first zome call would fail with
/// `NoSigningCredentialsForCell` -- caught by testing the actual contract
/// end to end against a real conductor, not assumed.
async function authorizeSigning(adminWs: AdminWebsocket, appInfo: AppInfo): Promise<void> {
  const cellInfo = appInfo.cell_info[ROLE_NAME]?.[0];
  if (!cellInfo || cellInfo.type !== CellType.Provisioned) {
    throw new Error(`no provisioned "${ROLE_NAME}" cell found on this app`);
  }
  const cellId: CellId = cellInfo.value.cell_id;
  await adminWs.authorizeSigningCredentials(cellId);
}

const HAPP_URL = "/handshake.happ";
/// The dev network's DNA properties (its issuer), when the dev seed has set
/// one up -- see web/scripts/seed.mjs. Absent in production, whose bundle
/// carries its properties itself.
const DEV_NETWORK_URL = "/dev-network.json";
const ALLOWED_ORIGINS = "*";

export interface ProvisionedIdentity {
  adminUrl: string;
  appUrl: string;
  token: number[];
  installedAppId: InstalledAppId;
  agentPubKey: AgentPubKey;
}

let happBundleBytes: Uint8Array | null = null;
/// The dev network's properties, or `null` outside dev.
async function fetchDevNetworkProperties(): Promise<Record<string, unknown> | null> {
  const res = await fetch(DEV_NETWORK_URL).catch(() => null);
  if (!res?.ok) return null;
  const network = (await res.json().catch(() => null)) as { properties?: Record<string, unknown> } | null;
  return network?.properties ?? null;
}

async function fetchHappBundle(): Promise<Uint8Array> {
  if (happBundleBytes) return happBundleBytes;
  const res = await fetch(HAPP_URL);
  if (!res.ok) throw new Error(`could not fetch ${HAPP_URL} (${res.status}) -- is the dev server running from web/ with public/handshake.happ present?`);
  happBundleBytes = new Uint8Array(await res.arrayBuffer());
  return happBundleBytes;
}

/// An app interface any identity can use: one the conductor already has
/// open if there is one, otherwise a newly attached one. Attached app
/// interfaces persist across conductor restarts, so attaching a fresh one
/// on every page load (what this used to do) opened one more port per
/// reload, forever, on a long-lived conductor -- confirmed against the
/// persistent dev conductor. App-scoped interfaces (`installed_app_id`
/// set) are skipped: they'd reject every other identity's token.
async function appInterfacePort(adminWs: AdminWebsocket): Promise<number> {
  const existing = await adminWs.listAppInterfaces();
  const shared = existing.find((i) => i.allowed_origins === ALLOWED_ORIGINS && !i.installed_app_id);
  if (shared) return shared.port;
  const { port } = await adminWs.attachAppInterface({ allowed_origins: ALLOWED_ORIGINS });
  return port;
}

/// Shared tail end of both provisionNewIdentity and reconnectIdentity: once
/// an app is installed/enabled and signing is authorized, both need the
/// same app-interface + auth token to hand back a usable ProvisionedIdentity.
async function attachInterfaceAndIssueToken(adminWs: AdminWebsocket, adminUrl: string, installedAppId: InstalledAppId, agentPubKey: AgentPubKey): Promise<ProvisionedIdentity> {
  const port = await appInterfacePort(adminWs);
  const issued = await adminWs.issueAppAuthenticationToken({ installed_app_id: installedAppId });
  const adminHost = new URL(adminUrl).hostname;
  return {
    adminUrl,
    appUrl: `ws://${adminHost}:${port}`,
    token: issued.token as unknown as number[],
    installedAppId,
    agentPubKey,
  };
}

/// Creates a brand new agent identity and installs a fresh `handshake` cell for
/// it. `installedAppId` should be unique per browser-tab-identity (the
/// caller persists it in localStorage to reconnect the *same* identity on
/// reload, rather than accidentally provisioning a new one every time).
///
/// `wsClientOptions` is for Node callers (scripts, tests) only. The admin
/// interface's `AllowedOrigins::Any` still requires *an* Origin header,
/// which browsers always send and Node's `ws` doesn't unless told to.
export async function provisionNewIdentity(adminUrl: string, installedAppId: InstalledAppId, wsClientOptions?: WsClientOptions): Promise<ProvisionedIdentity> {
  const adminWs = await AdminWebsocket.connect({ url: new URL(adminUrl), wsClientOptions });
  try {
    const agentPubKey = await adminWs.generateAgentPubKey();
    const bundleBytes = await fetchHappBundle();

    const devProperties = await fetchDevNetworkProperties();
    await adminWs.installApp({
      source: { type: "bytes", value: bundleBytes },
      agent_key: agentPubKey,
      installed_app_id: installedAppId,
      ...(devProperties && { roles_settings: { handshake: { type: "provisioned", value: { membrane_proof: undefined, modifiers: { network_seed: undefined, properties: devProperties } } } } }),
    } as Parameters<AdminWebsocket["installApp"]>[0]);
    const appInfo = await adminWs.enableApp({ installed_app_id: installedAppId });
    await authorizeSigning(adminWs, appInfo);

    return await attachInterfaceAndIssueToken(adminWs, adminUrl, installedAppId, agentPubKey);
  } finally {
    adminWs.client.close();
  }
}

/// Re-issues a fresh token for an *already-installed* app -- used when a
/// returning browser tab has a persisted `installedAppId` from a previous
/// session and just needs a new app-interface/token to reconnect with, not
/// a whole new identity. Signing credentials don't survive a page load, so
/// they're re-authorized; the app interface is reused (see
/// `appInterfacePort`).
export async function reconnectIdentity(adminUrl: string, installedAppId: InstalledAppId, agentPubKey: AgentPubKey, wsClientOptions?: WsClientOptions): Promise<ProvisionedIdentity> {
  const adminWs = await AdminWebsocket.connect({ url: new URL(adminUrl), wsClientOptions });
  try {
    // Gone from the node -- a dev reset wipes every identity on it -- is
    // its own case: nothing to retry, and the browser should forget it.
    const app = (await adminWs.listApps({})).find((a) => a.installed_app_id === installedAppId);
    if (!app || encodeHashToBase64(app.agent_pub_key) !== encodeHashToBase64(agentPubKey)) {
      const gone = new Error("This browser's identity isn't on the node any more -- the dev network was probably reset. Sign in again.");
      gone.name = "IdentityGone";
      throw gone;
    }
    // Signing credentials live in @holochain/client's in-memory module
    // state, not anywhere persisted -- a fresh page load has none, even
    // though the cell itself is still enabled from before. Re-enabling an
    // already-enabled app is a harmless no-op that hands back the same
    // AppInfo this needs to re-authorize against.
    const appInfo = await adminWs.enableApp({ installed_app_id: installedAppId });
    await authorizeSigning(adminWs, appInfo);

    return await attachInterfaceAndIssueToken(adminWs, adminUrl, installedAppId, agentPubKey);
  } finally {
    adminWs.client.close();
  }
}

/// Development's stand-in for a runtime stopping (`running: false`) or
/// restarting an identity's app -- see `devDevice.ts`.
export async function setIdentityRunning(adminUrl: string, installedAppId: InstalledAppId, running: boolean): Promise<void> {
  const adminWs = await AdminWebsocket.connect({ url: new URL(adminUrl) });
  try {
    if (running) await adminWs.enableApp({ installed_app_id: installedAppId });
    else await adminWs.disableApp({ installed_app_id: installedAppId });
  } finally {
    adminWs.client.close();
  }
}

export interface NodeIdentity {
  installedAppId: InstalledAppId;
  agentPubKey: AgentPubKey;
}

/// Every `handshake` identity installed on a node, oldest first -- for the
/// dev-only "use an existing identity" picker on the onboarding screen
/// (e.g. the people `npm run seed` creates).
export async function listNodeIdentities(adminUrl: string): Promise<NodeIdentity[]> {
  const adminWs = await AdminWebsocket.connect({ url: new URL(adminUrl) });
  try {
    const apps = await adminWs.listApps({});
    return apps
      // The dev network's issuer (web/scripts/seed.mjs) is a service, not a
      // person to sign in as.
      .filter((app) => (app.cell_info[ROLE_NAME] ?? []).length > 0 && app.installed_app_id !== "dev-issuer")
      .sort((a, b) => a.installed_at - b.installed_at)
      .map((app) => ({ installedAppId: app.installed_app_id, agentPubKey: app.agent_pub_key }));
  } finally {
    adminWs.client.close();
  }
}

export type { AppAuthenticationToken };
