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
import { AdminWebsocket, CellType } from "@holochain/client";
import type { AgentPubKey, AppAuthenticationToken, AppInfo, CellId, InstalledAppId, WsClientOptions } from "@holochain/client";

const ROLE_NAME = "relay";

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

const HAPP_URL = "/relay.happ";
const ALLOWED_ORIGINS = "*";

export interface ProvisionedIdentity {
  adminUrl: string;
  appUrl: string;
  token: number[];
  installedAppId: InstalledAppId;
  agentPubKey: AgentPubKey;
}

let happBundleBytes: Uint8Array | null = null;
async function fetchHappBundle(): Promise<Uint8Array> {
  if (happBundleBytes) return happBundleBytes;
  const res = await fetch(HAPP_URL);
  if (!res.ok) throw new Error(`could not fetch ${HAPP_URL} (${res.status}) -- is the dev server running from web/ with public/relay.happ present?`);
  happBundleBytes = new Uint8Array(await res.arrayBuffer());
  return happBundleBytes;
}

/// Shared tail end of both provisionNewIdentity and reconnectIdentity: once
/// an app is installed/enabled and signing is authorized, both need the
/// same app-interface + auth token to hand back a usable ProvisionedIdentity.
async function attachInterfaceAndIssueToken(adminWs: AdminWebsocket, adminUrl: string, installedAppId: InstalledAppId, agentPubKey: AgentPubKey): Promise<ProvisionedIdentity> {
  const { port } = await adminWs.attachAppInterface({ allowed_origins: ALLOWED_ORIGINS });
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

/// Creates a brand new agent identity and installs a fresh `relay` cell for
/// it. `installedAppId` should be unique per browser-tab-identity (the
/// caller persists it in localStorage to reconnect the *same* identity on
/// reload, rather than accidentally provisioning a new one every time).
///
/// `wsClientOptions` is never needed from a real browser -- browsers set
/// their own Origin header on every WebSocket connection and forbid JS from
/// overriding it, so this is silently inapplicable there. It exists purely
/// so this exact function can be verified from Node (which sends no Origin
/// header at all unless told to, unlike a browser) -- confirmed directly
/// while upgrading to Holochain 0.7.0: the admin interface's default
/// `AllowedOrigins::Any` still requires *an* Origin header to be present,
/// just not any specific value, which a bare Node `ws` connection doesn't
/// send on its own.
export async function provisionNewIdentity(adminUrl: string, installedAppId: InstalledAppId, wsClientOptions?: WsClientOptions): Promise<ProvisionedIdentity> {
  const adminWs = await AdminWebsocket.connect({ url: new URL(adminUrl), wsClientOptions });
  try {
    const agentPubKey = await adminWs.generateAgentPubKey();
    const bundleBytes = await fetchHappBundle();

    await adminWs.installApp({
      source: { type: "bytes", value: bundleBytes },
      agent_key: agentPubKey,
      installed_app_id: installedAppId,
    });
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
/// a whole new identity. Also re-attaches an app interface, since the
/// conductor may have restarted since the last session (no interfaces
/// survive a restart).
export async function reconnectIdentity(adminUrl: string, installedAppId: InstalledAppId, agentPubKey: AgentPubKey, wsClientOptions?: WsClientOptions): Promise<ProvisionedIdentity> {
  const adminWs = await AdminWebsocket.connect({ url: new URL(adminUrl), wsClientOptions });
  try {
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

export type { AppAuthenticationToken };
