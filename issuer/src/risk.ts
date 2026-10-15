// How much card money the issuer lets an account add, and when it pays an
// account out -- the issuer's own risk, since a chargeback after the
// credits are spent is its loss. Decided from what the network shows about
// the account (how long it's existed, across every key it has had, and how
// many orders it's completed) and what this service knows (its disputes).
//
//   - Adding funds is capped per day and per week, by tier: a new account
//     can add a little, and more as it orders. Every card form opened and
//     saved-card charge made counts, paid or not, so forms opened at once
//     can't add up past the cap.
//   - A card's first payment is verified with its bank (3-D Secure), which
//     moves a fraud chargeback's loss to the bank.
//   - An account with a dispute open, or lost, adds nothing and is paid
//     nothing until a person clears it.
//   - Cash-outs go back to the cards that paid first (payouts.ts), so card
//     money can't be turned into a bank transfer; and a young account's
//     first bank payouts wait until it's `payoutHoldMs` old.
import type { Store } from "./store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/// What the network shows about an account.
export interface AccountStanding {
  /// When it began (ms) -- its oldest key's first action; `null` if unseen.
  since: number | null;
  /// Orders it has completed, as customer and as driver.
  completedOrders: number;
}

/// A step of trust, and what it may add.
export interface Tier {
  minOrders: number;
  minAgeDays: number;
  dailyCents: number;
  weeklyCents: number;
}

/// The tiers when the issuer sets none (`TOPUP_TIERS`), in the network's
/// minor units.
export const DEFAULT_TIERS: Tier[] = [
  { minOrders: 0, minAgeDays: 0, dailyCents: 10_000, weeklyCents: 20_000 },
  { minOrders: 3, minAgeDays: 7, dailyCents: 30_000, weeklyCents: 100_000 },
  { minOrders: 20, minAgeDays: 30, dailyCents: 100_000, weeklyCents: 300_000 },
];

export interface RiskPolicy {
  tiers: Tier[];
  /// How old an account must be before it's paid out to a bank.
  payoutHoldMs: number;
}

/// The highest tier `standing` reaches.
export function tierFor(standing: AccountStanding, tiers: Tier[], now = Date.now()): Tier {
  const ageDays = standing.since === null ? 0 : (now - standing.since) / DAY_MS;
  const reached = tiers.filter((t) => standing.completedOrders >= t.minOrders && ageDays >= t.minAgeDays);
  return reached.reduce((best, t) => (t.dailyCents > best.dailyCents ? t : best), tiers[0]);
}

/// Why `agent` can't add `amount` now -- or `null` if they can.
export function topUpRefusal(store: Store, agent: string, amount: number, standing: AccountStanding, policy: RiskPolicy, format: (cents: number) => string, now = Date.now()): string | null {
  if (store.frozen(agent)) return "A card payment on this account is disputed, so it can't add funds until that's settled.";
  const tier = tierFor(standing, policy.tiers, now);
  const today = store.topUpsSince(agent, now - DAY_MS);
  const week = store.topUpsSince(agent, now - 7 * DAY_MS);
  const room = Math.min(tier.dailyCents - today, tier.weeklyCents - week);
  if (amount <= room) return null;
  const higher = policy.tiers.some((t) => t.dailyCents > tier.dailyCents);
  return `You can add ${format(Math.max(0, room))} more right now (up to ${format(tier.dailyCents)} a day and ${format(tier.weeklyCents)} a week)${higher ? ": it grows as you order" : ""}.`;
}

/// When an account may first be paid out to a bank (ms) -- now, if it's old
/// enough already.
export function bankPayoutFrom(standing: AccountStanding, policy: RiskPolicy, now = Date.now()): number {
  return standing.since === null ? now + policy.payoutHoldMs : Math.max(now, standing.since + policy.payoutHoldMs);
}

/// `TOPUP_TIERS` from the environment: a JSON array of tiers, lowest first.
export function parseTiers(raw: string | undefined): Tier[] {
  if (!raw) return DEFAULT_TIERS;
  const tiers = JSON.parse(raw) as Tier[];
  const sound = Array.isArray(tiers) && tiers.length > 0 && tiers.every((t) => [t.minOrders, t.minAgeDays, t.dailyCents, t.weeklyCents].every((n) => Number.isInteger(n) && n >= 0) && t.dailyCents <= t.weeklyCents);
  if (!sound) throw new Error("TOPUP_TIERS must be a JSON array of {minOrders, minAgeDays, dailyCents, weeklyCents}, each daily at most weekly");
  return tiers;
}
