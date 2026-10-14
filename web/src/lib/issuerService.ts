// Talking to an issuer's own service (its profile's `service_url`): adding
// funds by card, and setting up a payout account. Both end on the
// processor's own pages -- card details and bank details never touch Relay.
import { encodeHashToBase64 } from "@holochain/client";
import type { AgentPubKey } from "../holochain/types";
import { signIssuerLink } from "../holochain/zomes/ledger";

async function post<T>(serviceUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${serviceUrl.replace(/\/$/, "")}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "The issuer's service didn't answer. Try again shortly.");
  return data;
}

/// Where to pay `amount` by card, to add it to `agent`'s balance.
export async function addFundsUrl(serviceUrl: string, agent: AgentPubKey, amount: number): Promise<string> {
  return (await post<{ url: string }>(serviceUrl, "/topups", { agent: encodeHashToBase64(agent), amount })).url;
}

/// Where `agent` sets up their payout account with `issuer` -- after proving
/// to its service, by signing its one-time nonce, that they hold their key.
export async function payoutSetupUrl(serviceUrl: string, issuer: AgentPubKey, agent: AgentPubKey): Promise<string> {
  const id = encodeHashToBase64(agent);
  const { nonce } = await post<{ nonce: string }>(serviceUrl, "/payout-account/nonce", { agent: id });
  const signature = await signIssuerLink(issuer, nonce);
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return (await post<{ url: string }>(serviceUrl, "/payout-account", { agent: id, nonce, signature: btoa(binary) })).url;
}
