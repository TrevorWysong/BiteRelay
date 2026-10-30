// Talking to an issuer's own service (its profile's `service_url`): paying
// by card -- an embedded Stripe form, or the card saved last time -- and
// setting up a payout account. Card and bank details only ever reach the
// processor's own forms; never HandShake.
//
// Each request that touches someone's money is signed by them for its
// purpose (the ledger zome's `sign_issuer_link`, over the service's
// one-time nonce), so nobody can open a card form that saves a card to
// someone else, charge their saved card, or redirect their payouts.
import { encodeHashToBase64 } from "@holochain/client";
import type { AgentPubKey, IssuerProfile, IssuerRequest, IssuerView } from "../../holochain/types";
import { signIssuerLink } from "../../holochain/zomes/ledger";
import { t } from "../../i18n";

async function call<T>(serviceUrl: string, path: string, body?: unknown): Promise<T> {
  const url = `${serviceUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? t("issuer.noAnswer"));
  return data;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/// A request signed by `agent` for `purpose`, on the service's fresh nonce.
async function signed(serviceUrl: string, issuer: AgentPubKey, agent: AgentPubKey, purpose: IssuerRequest, extra: Record<string, unknown> = {}) {
  const id = encodeHashToBase64(agent);
  const { nonce } = await call<{ nonce: string }>(serviceUrl, "/nonce", {
    agent: id,
  });
  return {
    agent: id,
    nonce,
    signature: base64(await signIssuerLink(issuer, purpose, nonce)),
    ...extra,
  };
}

/// The issuer's publishable Stripe key, for its embedded card form.
export async function publishableKey(serviceUrl: string): Promise<string> {
  return (await call<{ publishableKey: string }>(serviceUrl, "/config")).publishableKey;
}

/// A card form to pay `amount` into `agent`'s balance -- its client
/// secret. The card is saved, for one tap next time.
export async function cardFormSecret(serviceUrl: string, issuer: AgentPubKey, agent: AgentPubKey, amount: number): Promise<string> {
  return (await call<{ clientSecret: string }>(serviceUrl, "/topups", await signed(serviceUrl, issuer, agent, "TopUp", { amount }))).clientSecret;
}

export interface SavedCard {
  brand: string;
  last4: string;
}

/// The card `agent` saved with this issuer, if any.
export async function savedCard(serviceUrl: string, issuer: AgentPubKey, agent: AgentPubKey): Promise<SavedCard | null> {
  return (await call<{ card: SavedCard | null }>(serviceUrl, "/saved-card", await signed(serviceUrl, issuer, agent, "SavedCard"))).card;
}

/// Pays `amount` into `agent`'s balance with their saved card. `false` if
/// their bank wants them to confirm it in the card form instead.
export async function payWithSavedCard(serviceUrl: string, issuer: AgentPubKey, agent: AgentPubKey, amount: number): Promise<boolean> {
  const result = await call<{ paid?: boolean; needsConfirmation?: boolean }>(serviceUrl, "/saved-card/charge", await signed(serviceUrl, issuer, agent, "SavedCard", { amount }));
  return !!result.paid;
}

/// Where `agent` sets up their payout account with `issuer`.
export async function payoutSetupUrl(serviceUrl: string, issuer: AgentPubKey, agent: AgentPubKey): Promise<string> {
  return (await call<{ url: string }>(serviceUrl, "/payout-account", await signed(serviceUrl, issuer, agent, "PayoutAccount"))).url;
}

/// The least a card payment may be, and the most -- the service's limits.
export const MIN_CARD_PAYMENT_CENTS = 500;
export const MAX_CARD_PAYMENT_CENTS = 50_000;

/// An issuer whose service the app can pay through.
export type PayableIssuer = IssuerView & { profile: IssuerProfile };

export function isPayable(issuer: IssuerView): issuer is PayableIssuer {
  return !!issuer.profile?.service_url;
}
