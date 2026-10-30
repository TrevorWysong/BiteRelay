// The dev network's issuer, from the terminal: what a real issuer's payout
// service does with its processor, done by hand -- see the ledger zome's
// `cash_out`. The seed creates the issuer (`npm run dev:reset`).
//
//   npm run issuer                         cash-outs waiting, numbered
//   npm run issuer -- pay 1                pay the first (or: pay all)
//   npm run issuer -- decline 1 "reason"   decline it; its funds go back
//   npm run issuer -- grant "Sam Patel" 25 add $25 to someone's balance
import { AppWebsocket, encodeHashToBase64, type ActionHash, type AdminWebsocket, type AgentPubKey } from "@holochain/client";
import { ISSUER_APP_ID, ROLE_NAME, WS_OPTIONS, appInterfacePort, closeApp, connectAdmin, messageOf } from "./lib/devEnv.ts";

/// A cash-out as `get_cash_out_requests` lists it.
interface CashOutRequest {
  redemption: ActionHash;
  redeemer: AgentPubKey;
  amount: number;
  requested_at: number;
  instructions: string;
  outcome: unknown;
}

interface CashOutPage {
  requests: CashOutRequest[];
  more: boolean;
  cursor: unknown;
}

const [command = "list", ...rest] = process.argv.slice(2);
const cents = (amount: number) => `$${(amount / 100).toFixed(2)}`;

/// A call as one of the conductor's apps.
async function connectAs(adminWs: AdminWebsocket, appId: string) {
  const app = (await adminWs.listApps({})).find((a) => a.installed_app_id === appId);
  if (!app) return null;
  const cell = app.cell_info[ROLE_NAME][0];
  if (cell.type !== "provisioned") return null;
  const cellId = cell.value.cell_id;
  await adminWs.authorizeSigningCredentials(cellId);
  const { token } = await adminWs.issueAppAuthenticationToken({ installed_app_id: appId });
  const appWs = await AppWebsocket.connect({ url: new URL(`ws://localhost:${await appInterfacePort(adminWs)}`), token, wsClientOptions: WS_OPTIONS, defaultTimeout: 60_000 });
  const call = <T>(zome: string, fn: string, payload: unknown = null) => appWs.callZome<T>({ cell_id: cellId, zome_name: zome, fn_name: fn, payload });
  return { cellId, call, close: () => closeApp(appWs) };
}

type Issuer = NonNullable<Awaited<ReturnType<typeof connectAs>>>;

/// Every cash-out the issuer has been asked for, oldest first.
async function allRequests(issuer: Issuer): Promise<CashOutRequest[]> {
  const requests: CashOutRequest[] = [];
  let after: unknown = null;
  for (;;) {
    const page = await issuer.call<CashOutPage>("ledger", "get_cash_out_requests", { after });
    requests.push(...page.requests);
    if (!page.more) return requests;
    after = page.cursor;
  }
}

/// Seeded people by app, for names.
async function names(adminWs: AdminWebsocket): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  for (const app of await adminWs.listApps({})) {
    if (!app.installed_app_id.startsWith("seed-")) continue;
    const name = app.installed_app_id.slice(5).split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    byKey.set(encodeHashToBase64(app.agent_pub_key), name);
  }
  return byKey;
}

async function main() {
  const adminWs = await connectAdmin();
  const issuer = await connectAs(adminWs, ISSUER_APP_ID);
  if (!issuer) {
    console.error("This dev network has no issuer yet. Run `npm run dev:reset` to set one up.");
    process.exit(1);
  }
  try {
    const people = await names(adminWs);
    const who = (key: AgentPubKey) => people.get(encodeHashToBase64(key)) ?? "a new identity";
    const waiting = (await allRequests(issuer)).filter((r) => !r.outcome);

    if (command === "list") {
      if (waiting.length === 0) console.log("No cash-outs waiting.");
      waiting.forEach((r, i) => console.log(`  ${i + 1}. ${cents(r.amount)} for ${who(r.redeemer)}, asked ${new Date(r.requested_at / 1000).toLocaleString()}${r.instructions ? ` -- "${r.instructions}"` : ""}`));
      return;
    }
    if (command === "pay" || command === "decline") {
      const which = rest[0] === "all" ? waiting : [waiting[Number(rest[0]) - 1]].filter(Boolean);
      if (which.length === 0) throw new Error(`No waiting cash-out "${rest[0] ?? ""}". \`npm run issuer\` lists them.`);
      for (const r of which) {
        const outcome = command === "pay" ? { Paid: { reference: `po_dev_${Date.now().toString(36)}` } } : { Declined: { reason: rest[1] ?? "Declined by the issuer." } };
        await issuer.call("ledger", "decide_cash_out", { redemption: r.redemption, outcome });
        console.log(`  ✓ ${command === "pay" ? "Paid" : "Declined"} ${cents(r.amount)} for ${who(r.redeemer)}`);
      }
      return;
    }
    if (command === "grant") {
      const [name, amount] = rest;
      const to = [...people.entries()].find(([, n]) => n.toLowerCase() === (name ?? "").toLowerCase());
      if (!to || !(Number(amount) > 0)) throw new Error('grant takes a seeded person\'s name and dollars: grant "Sam Patel" 25');
      const app = (await adminWs.listApps({})).find((a) => encodeHashToBase64(a.agent_pub_key) === to[0]);
      if (!app) throw new Error(`${to[1]} is no longer on this conductor`);
      await issuer.call("ledger", "issue_grant", { to: app.agent_pub_key, amount: Math.round(Number(amount) * 100), reference: `dev-grant-${Date.now().toString(36)}` });
      console.log(`  ✓ Added ${cents(Math.round(Number(amount) * 100))} for ${to[1]}; their app collects it shortly.`);
      return;
    }
    throw new Error(`Unknown command "${command}". Try: list, pay, decline, grant.`);
  } finally {
    await issuer.close();
    await adminWs.client.close();
  }
}

main().catch((err) => {
  console.error(`✗ ${messageOf(err)}`);
  process.exit(1);
});
