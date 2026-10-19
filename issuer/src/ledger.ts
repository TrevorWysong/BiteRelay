// The issuer's side of the Relay ledger -- the zome functions this service
// calls, as the issuer's own identity on its own conductor (the ledger
// zome's `cash_out` module, and the account zome's recoveries). An interface, so the service's logic is tested
// without a conductor.
//
// The connection heals itself: when the conductor restarts, its app port
// and the service's token are gone, so a failed call opens a new connection
// (port looked up again, new token) and runs once more. Every call is safe
// to repeat -- `issue_grant` returns a payment's existing grant, a cash-out
// decided already says so, and reads are reads.
import { AdminWebsocket, AppWebsocket, decodeHashFromBase64, encodeHashToBase64, type AgentPubKey, type CellId } from "@holochain/client";
import type { AccountStanding } from "./risk.ts";

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
  recovery_wait_days: number;
  /// The next version of the network, once there is one (MIGRATION.md).
  next_network?: Uint8Array | null;
}

/// An account moving to the next network that asked this issuer to carry
/// its balance -- the account zome's `MigrationRequest`.
export interface MigrationRequest {
  migration: Uint8Array;
  account: AgentPubKey;
  successor: AgentPubKey;
  network: Uint8Array;
  requested_at: number;
  /// The closed chain's last action, once the close is seen.
  close: Uint8Array | null;
}

export interface MigrationRequestsPage {
  requests: MigrationRequest[];
  cursor: number | null;
  more: boolean;
}

/// A key that took over an account -- `ledger`'s view of the account zome's
/// `SuccessionView`.
export interface Succession {
  succession: Uint8Array;
  predecessor: AgentPubKey;
  successor: AgentPubKey;
  kind: "HandOver" | "Phrase" | "Guardians";
  /// The plan a recovery rested on.
  plan: Uint8Array | null;
  at: number;
}

export interface ReissueRequest {
  succession: Uint8Array;
  predecessor: AgentPubKey;
  successor: AgentPubKey;
  requested_at: number;
}

export interface ReissueRequestsPage {
  requests: ReissueRequest[];
  cursor: number | null;
  more: boolean;
}

/// Where an account's ledger stood as of an action on its chain.
export interface Standing {
  balance: number;
  handed_over: boolean;
}

export interface IssuerLedger {
  /// The issuer's own agent key.
  readonly issuer: AgentPubKey;
  issueGrant(to: AgentPubKey, amount: number, reference: string): Promise<void>;
  cashOutRequests(after: number | null): Promise<CashOutRequestsPage>;
  decideCashOut(redemption: Uint8Array, outcome: PayoutOutcome): Promise<void>;
  setProfile(profile: IssuerProfile): Promise<void>;
  /// Every key that took over `account` and still stands -- a recovery
  /// whose plan the person has since replaced doesn't. None while it's in
  /// use.
  successionsOf(account: AgentPubKey): Promise<Succession[]>;
  reissueRequests(after: number | null): Promise<ReissueRequestsPage>;
  /// The latest action the network has seen on `agent`'s chain.
  latestActionOf(agent: AgentPubKey): Promise<Uint8Array | null>;
  standingAt(agent: AgentPubKey, head: Uint8Array): Promise<Standing>;
  /// How long `agent`'s account has existed and how much it has done.
  standingOf(agent: AgentPubKey): Promise<AccountStanding>;
  /// The network's currency, an ISO 4217 code.
  currency(): Promise<string>;
  /// This network's DNA hash.
  network(): Promise<Uint8Array>;
  migrationRequests(after: number | null): Promise<MigrationRequestsPage>;
  /// Arbiters' awards against `owner`'s stores, oldest first.
  rulingsAgainst(owner: AgentPubKey): Promise<RulingDue[]>;
}

/// An arbiter's award a store's owner pays from their cash-outs.
export interface RulingDue {
  ruling: Uint8Array;
  appeal: Uint8Array;
  order: Uint8Array;
  customer: AgentPubKey;
  award: number;
  ruled_at: number;
}

/// Agent keys as the service passes them around: base64, as the app shows them.
export const agentId = (key: AgentPubKey): string => encodeHashToBase64(key);
export const agentKey = (id: string): AgentPubKey => decodeHashFromBase64(id);

const WS_OPTIONS = { origin: "http://localhost" };
/// The client's errors for a connection that's gone, rather than a call
/// the conductor refused.
const CONNECTION_LOST = /could not connect|WebsocketClosedError|InvalidTokenError|ConnectionError|Websocket is not open|client closed with pending requests|ClientClosedWithPendingRequests/;

/// The issuer's app on the conductor at `adminUrl`, connected.
async function open(adminUrl: string, appId: string): Promise<{ agent: AgentPubKey; cellId: CellId; appWs: AppWebsocket }> {
  const admin = await AdminWebsocket.connect({ url: new URL(adminUrl), wsClientOptions: WS_OPTIONS, defaultTimeout: 60_000 });
  try {
    const app = (await admin.listApps({})).find((a) => a.installed_app_id === appId);
    if (!app) throw new Error(`No app "${appId}" on ${adminUrl} -- install the issuer's identity first.`);
    const cellId = (app.cell_info.relay[0] as { value: { cell_id: CellId } }).value.cell_id;
    await admin.authorizeSigningCredentials(cellId);
    const shared = (await admin.listAppInterfaces()).find((i) => i.allowed_origins === "*" && !i.installed_app_id);
    const port = shared?.port ?? (await admin.attachAppInterface({ allowed_origins: "*" })).port;
    const { token } = await admin.issueAppAuthenticationToken({ installed_app_id: appId });
    const appWs = await AppWebsocket.connect({ url: new URL(`ws://localhost:${port}`), token, wsClientOptions: WS_OPTIONS, defaultTimeout: 60_000 });
    return { agent: app.agent_pub_key, cellId, appWs };
  } finally {
    await admin.client.close();
  }
}

/// Connects as the issuer: its app on the conductor at `adminUrl`.
export async function connectIssuerLedger(adminUrl: string, appId: string): Promise<IssuerLedger & { close(): Promise<void> }> {
  let connection = await open(adminUrl, appId);
  let reopening: Promise<void> | null = null;
  const reopen = () =>
    (reopening ??= open(adminUrl, appId)
      .then((fresh) => {
        connection = fresh;
      })
      .finally(() => {
        reopening = null;
      }));

  async function call<T>(fn_name: string, payload: unknown, zome_name = "ledger"): Promise<T> {
    const send = () => connection.appWs.callZome<T>({ cell_id: connection.cellId, zome_name, fn_name, payload });
    try {
      return await send();
    } catch (err) {
      if (!CONNECTION_LOST.test(`${(err as Error)?.name} ${(err as Error)?.message}`)) throw err;
      await reopen();
      return send();
    }
  }

  return {
    issuer: connection.agent,
    issueGrant: async (to, amount, reference) => void (await call("issue_grant", { to, amount, reference })),
    cashOutRequests: (after) => call<CashOutRequestsPage>("get_cash_out_requests", { after }),
    decideCashOut: async (redemption, outcome) => void (await call("decide_cash_out", { redemption, outcome })),
    setProfile: async (profile) => void (await call("set_issuer_profile", profile)),
    successionsOf: (account) => call<Succession[]>("successions_of", account, "account"),
    reissueRequests: (after) => call<ReissueRequestsPage>("get_reissue_requests", { after }, "account"),
    latestActionOf: (agent) => call<Uint8Array | null>("latest_action_of", agent, "account"),
    standingAt: (agent, head) => call<Standing>("standing_at", { agent, head }),
    async standingOf(agent) {
      const completed = (target: unknown) => call<{ completed_count: number }>("get_reputation_summary", target, "reputation").then((s) => s.completed_count);
      const [since, asCustomer, asDriver] = await Promise.all([call<number | null>("account_since", agent, "account"), completed({ Customer: agent }), completed({ Driver: agent })]);
      return { since: since === null ? null : Math.floor(since / 1000), completedOrders: asCustomer + asDriver };
    },
    currency: () => call<{ currency: string }>("get_network_terms", null, "dispatch").then((t) => t.currency),
    network: () => call<Uint8Array>("network_hash", null, "account"),
    migrationRequests: (after) => call<MigrationRequestsPage>("get_migration_requests", { after }, "account"),
    rulingsAgainst: (owner) => call<RulingDue[]>("get_rulings_against", owner, "dispatch"),
    // The app socket's transport is typed narrowly; it's a WsClient.
    close: async () => void (await (connection.appWs.client as unknown as { close(): Promise<unknown> }).close()),
  };
}
