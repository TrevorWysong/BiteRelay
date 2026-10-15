// Auto top-up: when the balance runs low, the person's own app pays it back
// up with the card they saved -- the same signed one-tap charge they'd make
// themselves. The issuer caps saved-card charges a day, and this waits a
// while between tries, so a failing card isn't retried in a loop.
import { encodeHashToBase64 } from "@holochain/client";
import type { AgentPubKey } from "../holochain/types";
import { bytesToHex } from "../holochain/decode";
import { getBalance, listIssuers } from "../holochain/zomes/ledger";
import { useCustomerSettings } from "../store/roleSettings";
import { isPayable, payWithSavedCard } from "./issuerService";

/// The least time between tries, charged or not.
const RETRY_AFTER_MS = 30 * 60_000;
const lastTry = new Map<string, number>();

/// Tops `agent`'s balance up if they've turned it on and it's low; whether
/// it charged their card.
export async function topUpIfLow(agent: AgentPubKey): Promise<boolean> {
  const hex = bytesToHex(agent);
  const setting = useCustomerSettings.getState().autoTopUps[hex];
  if (!setting) return false;
  // Kept per tab, and in storage across tabs and reloads.
  const storeKey = `relay.auto-top-up.last.${encodeHashToBase64(agent)}`;
  const last = Math.max(lastTry.get(hex) ?? 0, Number(safeGet(storeKey)) || 0);
  if (Date.now() - last < RETRY_AFTER_MS) return false;
  if ((await getBalance(agent)) >= setting.belowCents) return false;
  const issuer = (await listIssuers()).find((i) => bytesToHex(i.issuer) === setting.issuer);
  if (!issuer || !isPayable(issuer)) return false;
  lastTry.set(hex, Date.now());
  safeSet(storeKey, String(Date.now()));
  // A card that needs its owner to confirm it waits for them to pay by hand.
  return payWithSavedCard(issuer.profile.service_url, issuer.issuer, agent, setting.amountCents);
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The in-memory record still spaces out this tab's tries.
  }
}
