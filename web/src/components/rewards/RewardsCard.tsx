import { useEffect, useState } from "react";
import { animate, motion } from "framer-motion";
import { Crown, Sparkles } from "lucide-react";
import clsx from "clsx";
import type { RewardsProgram } from "../../holochain/types";
import { ACCENTS } from "../../lib/rewards/rewards";
import { PendingChip } from "./PendingPoints";
import { useT } from "../../i18n";

/// A number that counts up to `value` when it changes.
export function CountUp({ value, className }: { value: number; className?: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const controls = animate(shown, value, { duration: 0.9, ease: [0.22, 1, 0.36, 1], onUpdate: (v) => setShown(Math.round(v)) });
    return () => controls.stop();
    // Animates from wherever it is now; `shown` isn't a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <span className={clsx("tabular-nums", className)}>{shown.toLocaleString()}</span>;
}

/// The rewards it shows on its track: the cheapest few the member could
/// have, by cost.
function milestones(program: RewardsProgram, tier: number) {
  return [...program.rewards].filter((r) => r.min_tier <= tier).sort((a, b) => a.cost - b.cost).slice(0, 4);
}

/// A member's card at a store: drawn in the program's colours, their
/// points counting up, their tier, and a track to the rewards ahead.
/// `compact` for a list of cards.
export function RewardsCard({
  program,
  storeName,
  balance,
  tier,
  expiresAt,
  pendingPoints = 0,
  compact = false,
  onClick,
}: {
  program: RewardsProgram;
  storeName: string;
  balance: number;
  tier: number;
  expiresAt?: number | null;
  /// Points on their way, still in their refund period.
  pendingPoints?: number;
  compact?: boolean;
  onClick?: () => void;
}) {
  const t = useT();
  const accent = ACCENTS[program.accent];
  const tierName = tier > 0 ? program.tiers[tier - 1]?.name : null;
  const marks = milestones(program, tier);
  const top = marks.find((m) => m.cost > balance)?.cost ?? marks[marks.length - 1]?.cost ?? 0;
  const fill = top > 0 ? Math.min(1, balance / top) : 0;
  const next = marks.find((m) => m.cost > balance);

  return (
    <motion.div
      whileTap={onClick ? { scale: 0.98 } : undefined}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      className={clsx("relative isolate overflow-hidden rounded-[28px] text-white", compact ? "p-5" : "p-6", onClick && "cursor-pointer")}
      style={{ backgroundImage: `linear-gradient(135deg, ${accent.from}, ${accent.to})`, boxShadow: `0 20px 40px -18px ${accent.glow}` }}
    >
      {/* Light falling across the card, and a soft ring of its colour. */}
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 -z-10 h-64 w-64 rounded-full bg-white/20 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-28 -left-10 -z-10 h-56 w-56 rounded-full bg-black/20 blur-3xl" />
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 -z-10 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/15 to-transparent"
        initial={{ x: "-150%" }}
        animate={{ x: "350%" }}
        transition={{ duration: 2.4, delay: 0.4, ease: "easeInOut", repeat: Infinity, repeatDelay: 6 }}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">{storeName}</p>
          <p className={clsx("truncate font-black tracking-tight", compact ? "text-base" : "text-lg")}>{program.name}</p>
        </div>
        {tierName ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider backdrop-blur-sm">
            <Crown size={12} /> {tierName}
          </span>
        ) : (
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/15 backdrop-blur-sm">
            <Sparkles size={15} />
          </span>
        )}
      </div>

      <div className={clsx("flex items-end gap-2", compact ? "mt-4" : "mt-6")}>
        <CountUp value={balance} className={clsx("font-black leading-none tracking-tight", compact ? "text-4xl" : "text-6xl")} />
        <span className="pb-1 text-sm font-semibold text-white/80">{program.points_name}</span>
      </div>
      {pendingPoints > 0 && (
        <div className="mt-2">
          <PendingChip points={pendingPoints} name={program.points_name} />
        </div>
      )}

      {marks.length > 0 && (
        <div className={compact ? "mt-4" : "mt-6"}>
          <div className="relative h-2.5 rounded-full bg-black/20">
            <motion.div className="absolute inset-y-0 left-0 rounded-full bg-white" initial={{ width: 0 }} animate={{ width: `${fill * 100}%` }} transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.15 }} />
            {!compact &&
              marks
                .filter((m) => m.cost <= top)
                .map((m) => (
                  <span
                    key={m.id}
                    className={clsx("absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2", balance >= m.cost ? "border-white bg-white" : "border-white/60 bg-transparent")}
                    style={{ left: `${(m.cost / top) * 100}%` }}
                  />
                ))}
          </div>
          <p className="mt-2 text-xs font-medium text-white/85">
            {next ? t("rewards.toNext", { points: (next.cost - balance).toLocaleString(), name: next.name }) : t("rewards.allUnlocked")}
          </p>
        </div>
      )}

      {!compact && (program.tagline || expiresAt) && (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/15 pt-3 text-xs text-white/75">
          <span className="min-w-0 truncate">{program.tagline}</span>
          {expiresAt && balance > 0 && <span className="shrink-0">{t("rewards.expires", { date: new Date(expiresAt / 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) })}</span>}
        </div>
      )}
      {!program.active && <div className="mt-3 rounded-xl bg-black/25 px-3 py-2 text-xs font-semibold">{t("rewards.paused")}</div>}
    </motion.div>
  );
}
