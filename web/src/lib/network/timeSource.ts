// The network's public time source (drand by default -- a randomness beacon
// run jointly by independent organisations, publishing a signed value every
// few seconds). A step whose rule turns on a deadline someone else could
// dispute -- a driver leaving an order, calling a store late -- carries the
// current round: nobody could know it before it was published, so the step
// wasn't written earlier. Validation checks its signature against the
// network's key; this only fetches it, from the relays the network names.
import type { Beacon } from "../../holochain/types";
import { currentTerms } from "../../store/network";
import { withTimeout } from "../util/timeout";

/// How long one relay gets before the next is tried.
const RELAY_TIMEOUT_MS = 5_000;

interface PublishedRound {
  round: number;
  signature: string;
}

/// The latest round, from the first of the network's relays that answers.
export async function currentBeacon(): Promise<Beacon> {
  const { time_relays, time_chain_hash } = currentTerms();
  for (const relay of time_relays) {
    try {
      const response = await withTimeout(fetch(`${relay}/${time_chain_hash}/public/latest`), RELAY_TIMEOUT_MS, "time source timed out");
      if (!response.ok) continue;
      const published = (await response.json()) as PublishedRound;
      const signature = hexToBytes(published.signature);
      if (Number.isSafeInteger(published.round) && published.round > 0 && signature) return { round: published.round, signature };
    } catch {
      // The next relay.
    }
  }
  throw new Error("Couldn't reach the network's time source. Check your connection and try again.");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
