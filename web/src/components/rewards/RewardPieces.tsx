import { motion } from "framer-motion";
import { Cake, Check, Clock, Crown, Flame, Gift, Hourglass, Lock, Percent, Sparkles, Star, Ticket } from "lucide-react";
import clsx from "clsx";
import type { PointsState, PromoReward, Reward, RewardsProgram } from "../../holochain/types";
import type { ItemRow } from "../../lib/menu/menu";
import { ACCENTS, describeHappyHour, nextTier, redeemable, tierOf } from "../../lib/rewards/rewards";
import { describeReward } from "../../lib/menu/promotions";
import { bytesToHex } from "../../holochain/decode";
import { formatCents } from "../../lib/ui/format";
import { useT } from "../../i18n";

/// The item a reward gives, if it gives one.
function rewardItem(benefit: PromoReward): Uint8Array | null {
  if ("FreeItem" in benefit) return benefit.FreeItem.item_ref;
  if ("PercentOffItem" in benefit) return benefit.PercentOffItem.item_ref;
  return null;
}

/// A reward's look: the item's photo when it's for an item, else a symbol.
function RewardArt({ benefit, menu, accent }: { benefit: PromoReward; menu: ItemRow[]; accent: RewardsProgram["accent"] }) {
  const item = rewardItem(benefit);
  const photo = item ? menu.find((m) => bytesToHex(m.hash) === bytesToHex(item))?.item.photo_data_uri : undefined;
  if (photo) return <img src={photo} alt="" className="h-full w-full object-cover" />;
  const Icon = "FreeItem" in benefit ? Gift : "FlatOffSubtotal" in benefit ? Ticket : Percent;
  const colors = ACCENTS[accent];
  return (
    <div className="grid h-full w-full place-items-center" style={{ backgroundImage: `linear-gradient(135deg, ${colors.from}33, ${colors.to}44)` }}>
      <Icon size={30} style={{ color: colors.to }} />
    </div>
  );
}

/// One reward, as a member sees it: ready, so many points away, or for a
/// higher tier.
export function RewardTile({ program, reward, balance, tier, menu, selected, onSelect }: { program: RewardsProgram; reward: Reward; balance: number; tier: number; menu: ItemRow[]; selected?: boolean; onSelect?: () => void }) {
  const t = useT();
  const state = redeemable(program, balance, tier, reward);
  const itemName = (hex: string) => menu.find((m) => bytesToHex(m.hash) === hex)?.item.name;
  const progress = Math.min(1, balance / reward.cost);
  const colors = ACCENTS[program.accent];
  return (
    <motion.button
      type="button"
      whileTap={onSelect && state === "ok" ? { scale: 0.96 } : undefined}
      onClick={state === "ok" ? onSelect : undefined}
      disabled={!onSelect || state !== "ok"}
      className={clsx(
        "relative w-40 shrink-0 snap-start overflow-hidden rounded-3xl bg-white text-left shadow-[var(--shadow-card)] ring-2 transition dark:bg-ink-900",
        selected ? "ring-offset-2 dark:ring-offset-ink-950" : "ring-transparent",
        state !== "ok" && "opacity-95",
      )}
      style={selected ? { ["--tw-ring-color" as string]: colors.to } : undefined}
    >
      <div className={clsx("relative h-24 w-full", state === "tier" && "grayscale")}>
        <RewardArt benefit={reward.benefit} menu={menu} accent={program.accent} />
        <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-bold text-white backdrop-blur-sm">
          {reward.cost.toLocaleString()} {program.points_name}
        </span>
        {selected && (
          <span className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-white" style={{ background: colors.to }}>
            <Check size={14} strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="p-3">
        <p className="line-clamp-2 min-h-[2.5rem] text-sm font-bold leading-tight text-ink-900 dark:text-ink-50">{reward.name}</p>
        <p className="mt-0.5 truncate text-[11px] text-ink-400">{describeReward(reward.benefit, itemName)}</p>
        {state === "ok" && <p className="mt-2 text-xs font-bold" style={{ color: colors.to }}>{onSelect ? t("rewards.tapToUse") : t("rewards.ready")}</p>}
        {state === "points" && (
          <div className="mt-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
              <motion.div className="h-full rounded-full" style={{ background: colors.to }} initial={{ width: 0 }} animate={{ width: `${progress * 100}%` }} transition={{ duration: 0.8 }} />
            </div>
            <p className="mt-1 text-[11px] text-ink-400">{t("rewards.toGo", { points: (reward.cost - balance).toLocaleString() })}</p>
          </div>
        )}
        {state === "tier" && (
          <p className="mt-2 flex items-center gap-1 text-[11px] font-semibold text-ink-500">
            <Lock size={11} /> {t("rewards.forTier", { tier: program.tiers[reward.min_tier - 1]?.name ?? "" })}
          </p>
        )}
        {state === "paused" && <p className="mt-2 text-[11px] text-ink-400">{t("rewards.paused")}</p>}
      </div>
    </motion.button>
  );
}

/// A row of rewards, scrolled sideways.
export function RewardRail({ children }: { children: React.ReactNode }) {
  return <div className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2">{children}</div>;
}

/// The program's tiers, the member's marked, with the way to the next.
export function TierLadder({ program, state }: { program: RewardsProgram; state: PointsState | null }) {
  const t = useT();
  if (program.tiers.length === 0) return null;
  const tier = tierOf(program, state);
  const next = nextTier(program, state);
  const colors = ACCENTS[program.accent];
  const levels = [{ name: t("rewards.member"), threshold: 0, percent: 100, perk: "" }, ...program.tiers];
  return (
    <div className="rounded-3xl bg-white p-5 shadow-[var(--shadow-card)] dark:bg-ink-900">
      {next && (
        <div className="mb-4">
          <div className="mb-1.5 flex items-baseline justify-between text-xs">
            <span className="font-bold text-ink-900 dark:text-ink-50">{t("rewards.toTier", { points: next.needed.toLocaleString(), tier: next.name })}</span>
            <span className="text-ink-400">{t("rewards.thisYear")}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
            <motion.div className="h-full rounded-full" style={{ backgroundImage: `linear-gradient(90deg, ${colors.from}, ${colors.to})` }} initial={{ width: 0 }} animate={{ width: `${next.progress * 100}%` }} transition={{ duration: 1 }} />
          </div>
        </div>
      )}
      <ol className="flex flex-col gap-3">
        {levels.map((level, i) => {
          const reached = i <= tier;
          const current = i === tier;
          return (
            <li key={level.name + i} className="flex items-center gap-3">
              <span
                className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-full", !reached && "bg-ink-100 text-ink-400 dark:bg-ink-800")}
                style={reached ? { backgroundImage: `linear-gradient(135deg, ${colors.from}, ${colors.to})`, color: "white" } : undefined}
              >
                {i === 0 ? <Star size={15} /> : <Crown size={15} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-bold text-ink-900 dark:text-ink-50">
                  {level.name}
                  {current && <span className="rounded-full bg-ink-900 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white dark:bg-white dark:text-ink-900">{t("rewards.you")}</span>}
                </p>
                <p className="truncate text-xs text-ink-400">
                  {i === 0 ? t("rewards.everyone") : t("rewards.tierLine", { points: level.threshold.toLocaleString(), rate: (level.percent / 100).toString() })}
                  {level.perk ? ` · ${level.perk}` : ""}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/// How points are earned at a store, in plain lines.
export function HowYouEarn({ program, menu }: { program: RewardsProgram; menu: ItemRow[] }) {
  const t = useT();
  const colors = ACCENTS[program.accent];
  const itemName = (ref: Uint8Array) => menu.find((m) => bytesToHex(m.hash) === bytesToHex(ref))?.item.name ?? t("promo.item");
  const rows: { icon: typeof Star; text: string }[] = [{ icon: Sparkles, text: t("rewards.earnRate", { points: program.earn.points_per_dollar, name: program.points_name }) }];
  if (program.earn.welcome_bonus > 0) rows.push({ icon: Gift, text: t("rewards.welcomeLine", { points: program.earn.welcome_bonus.toLocaleString(), name: program.points_name }) });
  for (const bonus of program.earn.item_bonuses) rows.push({ icon: Flame, text: t("rewards.itemBonusLine", { item: itemName(bonus.item_ref), rate: (bonus.percent / 100).toString() }) });
  for (const hour of program.earn.happy_hours) rows.push({ icon: Clock, text: t("rewards.happyLine", { rate: (hour.percent / 100).toString(), when: describeHappyHour(hour.days, hour.start_minute, hour.end_minute, t) }) });
  if (program.birthday_points > 0) rows.push({ icon: Cake, text: t("rewards.birthdayLine", { points: program.birthday_points.toLocaleString(), name: program.points_name }) });
  if (program.earn.min_order_cents > 0) rows.push({ icon: Ticket, text: t("rewards.minLine", { amount: formatCents(program.earn.min_order_cents) }) });
  if (program.expiry_days !== null) rows.push({ icon: Hourglass, text: t("rewards.expiryLine", { days: program.expiry_days }) });
  return (
    <ul className="flex flex-col gap-3 rounded-3xl bg-white p-5 shadow-[var(--shadow-card)] dark:bg-ink-900">
      {rows.map(({ icon: Icon, text }, i) => (
        <li key={i} className="flex items-center gap-3 text-sm text-ink-700 dark:text-ink-200">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full" style={{ background: `${colors.from}22`, color: colors.to }}>
            <Icon size={15} />
          </span>
          {text}
        </li>
      ))}
    </ul>
  );
}
