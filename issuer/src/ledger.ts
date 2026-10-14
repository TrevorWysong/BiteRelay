// The issuer's side of the Relay ledger -- the zome functions this service
// calls, as the issuer's own identity on its own conductor (see the ledger
// zome's `cash_out` module). An interface, so the service's logic is tested
// without a conductor.
import { AdminWebsocket, AppWebsocket, decodeHashFromBase64, encodeHashToBase64, type AgentPubKey, type CellId } from "@holochain/client";

export type PayoutOutcome = { Paid: { reference: string } } | { Declined: { reason: string } };

export interface CashOutRequest {
  redemption: Uint8Array;
  redeemer: AgentPubKey;
  amount: number;
  requested_at: number;
  instructions: string;
  outcome: PayoutOutcome | null;
}

export interface CashOutRequestsPage {
  requests: CashOutRequest[];
  cursor: number | null;
  more: boolean;
}

export interface IssuerProfile {
  name: string;
  description: string;
  contact: string;
  payout_fee_cents: number;
  payout_fee_basis_points: number;
  min_payout_cents: number;
  payout_days: number;
  service_url: string;
}

export interface IssuerLedger {
  /// The issuer's own agent key.
  readonly issuer: AgentPubKey;
  issueGrant(to: AgentPubKey, amount: number, reference: string): Promise<void>;
  cashOutRequests(after: number | null): Promise<CashOutRequestsPage>;
  decideCashOut(redemption: Uint8Array, outcome: PayoutOutcome): Promise<void>;
  setProfile(profile: IssuerProfile): Promise<void>;
}

/// Agent keys as the service passes them around: base64, as the app shows them.
export const agentId = (key: AgentPubKey): string => encodeHashToBase64(key);
export const agentKey = (id: string): AgentPubKey => decodeHashFromBase64(id);

/// Connects as the issuer: its app on the conductor at `adminUrl`.
export async function connectIssuerLedger(adminUrl: string, appId: string): Promise<IssuerLedger & { close(): Promise<void> }> {
  const wsClientOptions = { origin: "http://localhost" };
  const admin = await AdminWebsocket.connect({ url: new URL(adminUrl), wsClientOptions, defaultTimeout: 60_000 });
  const app = (await admin.listApps({})).find((a) => a.installed_app_id === appId);
  if (!app) throw new Error(`No app "${appId}" on ${adminUrl} -- install the issuer's identity first.`);
  const cellId = (app.cell_info.relay[0] as { value: { cell_id: CellId } }).value.cell_id;
  await admin.authorizeSigningCredentials(cellId);
  const shared = (await admin.listAppInterfaces()).find((i) => i.allowed_origins === "*" && !i.installed_app_id);
  const port = shared?.port ?? (await admin.attachAppInterface({ allowed_origins: "*" })).port;
  const { token } = await admin.issueAppAuthenticationToken({ installed_app_id: appId, single_use: false, expiry_seconds: 0 });
  const appWs = await AppWebsocket.connect({ url: new URL(`ws://localhost:${port}`), token, wsClientOptions, defaultTimeout: 60_000 });
  const call = <T>(fn_name: string, payload: unknown) => appWs.callZome<T>({ cell_id: cellId, zome_name: "ledger", fn_name, payload });
  return {
    issuer: app.agent_pub_key,
    issueGrant: async (to, amount, reference) => void (await call("issue_grant", { to, amount, reference })),
    cashOutRequests: (after) => call<CashOutRequestsPage>("get_cash_out_requests", { after }),
    decideCashOut: async (redemption, outcome) => void (await call("decide_cash_out", { redemption, outcome })),
    setProfile: async (profile) => void (await call("set_issuer_profile", profile)),
    close: async () => {
      // The app socket's transport is typed narrowly; it's a WsClient.
      await (appWs.client as unknown as { close(): Promise<unknown> }).close();
      await admin.client.close();
    },
  };
}
