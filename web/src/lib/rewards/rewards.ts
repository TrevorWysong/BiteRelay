// Rewards, as the app reads and previews them -- the same rules as
// `rewards_types::points`, which validation enforces. The same cases run in
// web/test/rewards.test.ts and the Rust tests; keep them in step.
import type { CartLine } from "../../store/cart";
import type { Accent, PointsState, PointsStatus, PromoReward, Reward, RewardsProgram } from "../../holochain/types";
import { bytesToHex } from "../../holochain/decode";
import { computePromoEffect } from "../menu/promotions";
import type { Translate } from "../../i18n";

export type { Accent };

const DAY_MICROS = 86_400_000_000;

/// A moment in a program's local time.
export interface LocalTime {
  year: number;
  /// 0 (Monday) to 6 (Sunday).
  weekday: number;
  /// Minutes after midnight.
  minute: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/// `atMicros` in `timeZone` (an IANA zone; an unknown one reads as UTC).
export function localTime(atMicros: number, timeZone: string): LocalTime {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch {
    format = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(Math.floor(atMicros / 1000))).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), weekday: WEEKDAYS.indexOf(parts.weekday), minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/// The tier `state` puts a member in: 0 the base, `n` the program's `n`th.
export function tierOf(program: RewardsProgram, state: PointsState | null): number {
  if (!state) return 0;
  const earned = Math.max(state.earned_this_year, state.earned_last_year);
  let tier = 0;
  for (const t of program.tiers) {
    if (earned < t.threshold) break;
    tier++;
  }
  return tier;
}

/// What tier `tier` earns at, in percent.
export function tierPercent(program: RewardsProgram, tier: number): number {
  return tier === 0 ? 100 : (program.tiers[tier - 1]?.percent ?? 100);
}

/// The next tier up, and how far there is to go -- `null` at the top.
export function nextTier(program: RewardsProgram, state: PointsState | null): { index: number; name: string; needed: number; progress: number } | null {
  const tier = tierOf(program, state);
  const next = program.tiers[tier];
  if (!next) return null;
  const earned = state?.earned_this_year ?? 0;
  const floor = tier === 0 ? 0 : program.tiers[tier - 1].threshold;
  return { index: tier + 1, name: next.name, needed: Math.max(0, next.threshold - earned), progress: Math.min(1, Math.max(0, (earned - floor) / (next.threshold - floor))) };
}

/// What an order earns before the member's tier (`points::order_points`):
/// each line's share of the food paid, at the program's rate, faster for a
/// bonus item, then for a happy hour it's placed in.
export function orderPoints(program: RewardsProgram, lines: { itemRef: Uint8Array; totalCents: number }[], eligibleCents: number, placedAtMicros: number): number {
  if (eligibleCents <= 0 || eligibleCents < program.earn.min_order_cents) return 0;
  const subtotal = lines.reduce((sum, l) => sum + l.totalCents, 0);
  if (subtotal === 0) return 0;
  const rate = BigInt(program.earn.points_per_dollar);
  let scaled = 0n;
  for (const line of lines) {
    const share = (BigInt(line.totalCents) * BigInt(eligibleCents)) / BigInt(subtotal);
    const bonus = program.earn.item_bonuses.find((b) => bytesToHex(b.item_ref) === bytesToHex(line.itemRef));
    scaled += (share * rate * BigInt(bonus?.percent ?? 100)) / 100n;
  }
  const local = localTime(placedAtMicros, program.time_zone);
  const happy = program.earn.happy_hours
    .filter((h) => (h.days & (1 << local.weekday)) !== 0 && local.minute >= h.start_minute && local.minute < h.end_minute)
    .reduce((best, h) => Math.max(best, h.percent), 100);
  return Number((scaled * BigInt(happy)) / 100n / 100n);
}

/// What an order earns a member in `state`: their tier's rate, the order
/// cap, and a welcome on their first (`points::step`).
export function earnedFor(program: RewardsProgram, state: PointsState | null, base: number): number {
  if (base <= 0) return 0;
  let earned = Math.floor((base * tierPercent(program, tierOf(program, state))) / 100);
  if (program.earn.max_per_order !== null) earned = Math.min(earned, program.earn.max_per_order);
  if (!state || state.orders === 0) earned += program.earn.welcome_bonus;
  return earned;
}

/// The happy hour on now, if any.
export function happyHourNow(program: RewardsProgram, nowMicros: number) {
  const local = localTime(nowMicros, program.time_zone);
  return program.earn.happy_hours.find((h) => (h.days & (1 << local.weekday)) !== 0 && local.minute >= h.start_minute && local.minute < h.end_minute) ?? null;
}

/// Whether a member can redeem `reward` now, and if not why.
export type Redeemable = "ok" | "points" | "tier" | "paused";
export function redeemable(program: RewardsProgram, balance: number, tier: number, reward: Reward): Redeemable {
  if (!program.active) return "paused";
  if (tier < reward.min_tier) return "tier";
  return balance >= reward.cost ? "ok" : "points";
}

/// What a reward takes off this cart -- priced as validation prices it.
export function rewardDiscount(benefit: PromoReward, lines: CartLine[]): number {
  const subtotal = lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0);
  return Math.min(subtotal, computePromoEffect(benefit, lines, subtotal).subtotalDiscountCents);
}

/// When points expire, in microseconds -- `null` if they don't.
export function expiresAt(program: RewardsProgram, state: PointsState | null): number | null {
  if (program.expiry_days === null || !state?.last_earned_at) return null;
  return state.last_earned_at + program.expiry_days * DAY_MICROS;
}

/// The colours a program's card is drawn in.
export const ACCENTS: Record<Accent, { from: string; to: string; glow: string; ink: string }> = {
  Ember: { from: "#ff7a47", to: "#c73312", glow: "rgba(255, 90, 43, 0.45)", ink: "#fff3ee" },
  Citrus: { from: "#fbbf24", to: "#ea580c", glow: "rgba(245, 158, 11, 0.45)", ink: "#fffbeb" },
  Forest: { from: "#34d399", to: "#065f46", glow: "rgba(16, 185, 129, 0.4)", ink: "#ecfdf5" },
  Ocean: { from: "#38bdf8", to: "#1e3a8a", glow: "rgba(14, 165, 233, 0.4)", ink: "#f0f9ff" },
  Berry: { from: "#f472b6", to: "#6b21a8", glow: "rgba(219, 39, 119, 0.4)", ink: "#fdf2f8" },
  Midnight: { from: "#475569", to: "#020617", glow: "rgba(51, 65, 85, 0.5)", ink: "#f8fafc" },
};

export const ACCENT_NAMES: Accent[] = ["Ember", "Citrus", "Forest", "Ocean", "Berry", "Midnight"];

/// A program a store starts from: earning, a welcome, a first reward.
export function starterProgram(catalogRef: Uint8Array, storeName: string): RewardsProgram {
  return {
    catalog_ref: catalogRef,
    active: true,
    name: `${storeName} Rewards`.slice(0, 40),
    points_name: "points",
    tagline: "",
    accent: "Ember",
    earn: { points_per_dollar: 10, min_order_cents: 0, max_per_order: null, welcome_bonus: 50, item_bonuses: [], happy_hours: [] },
    tiers: [],
    rewards: [],
    birthday_points: 0,
    expiry_days: null,
    max_balance: null,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/// "Mon, Wed 2:00 PM-4:00 PM".
export function describeHappyHour(days: number, start: number, end: number, t: Translate): string {
  const named = DAY_KEYS.filter((_, i) => days & (1 << i)).map((d) => t(`rewards.day.${d}`));
  const clock = (minute: number) => new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const when = days === 0b111_1111 ? t("rewards.everyDay") : named.join(", ");
  return `${when} · ${clock(start)}–${clock(end)}`;
}


export const shortDate = (micros: number) => new Date(micros / 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/// Where a pending order's points stand, in a few words.
export function pendingLine(status: PointsStatus, t: Translate): string {
  if (status === "Settling") return t("rewards.pending.settling");
  if (status === "InReview") return t("rewards.pending.review");
  if (status === "Arriving") return t("rewards.pending.arriving");
  if (status === "Earned") return t("rewards.pending.earned");
  return t("rewards.pending.arrives", { date: shortDate(status.RefundPeriod.until) });
}

