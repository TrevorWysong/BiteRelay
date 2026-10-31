import { motion } from "framer-motion";
import { Check, Clock, Hourglass, Scale, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import type { OrderPoints, PointsStatus, RewardsProgram } from "../../holochain/types";
import { bytesToHex } from "../../holochain/decode";
import { myCard, orderPoints } from "../../holochain/zomes/rewards";
import { useResource } from "../../lib/hooks/useResource";
import { ACCENTS, pendingLine, shortDate } from "../../lib/rewards/rewards";
import { useT } from "../../i18n";

function StatusIcon({ status, size = 15 }: { status: PointsStatus; size?: number }) {
  if (status === "Earned") return <Check size={size} strokeWidth={3} />;
  if (status === "InReview") return <Scale size={size} />;
  if (status === "Arriving") return <Sparkles size={size} />;
  if (status === "Settling") return <Hourglass size={size} />;
  return <Clock size={size} />;
}

/// The points on their way at a store: a chip for the card.
export function PendingChip({ points, name }: { points: number; name: string }) {
  const t = useT();
  if (points <= 0) return null;
  return (
    <motion.span initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-bold backdrop-blur-sm">
      <Clock size={11} /> {t("rewards.pendingChip", { points: points.toLocaleString(), name })}
    </motion.span>
  );
}

/// Each order's points on their way, with when they arrive -- under a line
/// on why they wait.
export function PendingList({ program, pending }: { program: RewardsProgram; pending: OrderPoints[] }) {
  const t = useT();
  const colors = ACCENTS[program.accent];
  return (
    <div className="overflow-hidden rounded-3xl bg-white shadow-[var(--shadow-card)] dark:bg-ink-900">
      <ul className="divide-y divide-ink-100 dark:divide-ink-800">
        {pending.map((p) => (
          <li key={bytesToHex(p.order)} className="flex items-center gap-3 px-5 py-3.5">
            <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full" style={{ background: `${colors.from}1f`, color: colors.to }}>
              <StatusIcon status={p.status} />
              {p.status === "Settling" && <span className="absolute inset-0 animate-ping rounded-full opacity-20" style={{ background: colors.from }} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{t("rewards.pending.order", { date: shortDate(p.placed_at) })}</p>
              <p className="truncate text-xs text-ink-400">{pendingLine(p.status, t)}</p>
            </div>
            <span className="text-sm font-black tabular-nums opacity-70" style={{ color: colors.to }}>
              +{p.points.toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-ink-100 bg-ink-50/60 px-5 py-3 text-xs text-ink-500 dark:border-ink-800 dark:bg-ink-800/40">{t("rewards.pending.why")}</p>
    </div>
  );
}

/// On an order's page: what it earns, and when -- or that it has.
export function OrderPointsBadge({ orderRef }: { orderRef: Uint8Array }) {
  const t = useT();
  const hex = bytesToHex(orderRef);
  const { data: points } = useResource(`rewards:order:${hex}`, () => orderPoints(orderRef));
  const storeHex = points ? bytesToHex(points.catalog_ref) : null;
  const { data: card } = useResource(storeHex ? `rewards:card:${storeHex}` : null, () => myCard(points!.catalog_ref));
  const program = card?.program?.program;
  if (!points || !program) return null;
  const colors = ACCENTS[program.accent];
  const earned = points.status === "Earned";
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-5">
      <Link
        to={`/rewards/${storeHex}`}
        className="relative flex items-center gap-3 overflow-hidden rounded-2xl p-4 text-white"
        style={{ backgroundImage: `linear-gradient(120deg, ${colors.from}, ${colors.to})`, boxShadow: `0 12px 28px -16px ${colors.glow}` }}
      >
        <div aria-hidden className="absolute -right-8 -top-10 h-28 w-28 rounded-full bg-white/20 blur-2xl" />
        <span className={clsx("grid h-11 w-11 shrink-0 place-items-center rounded-xl", earned ? "bg-white text-ink-900" : "bg-white/20")}>
          <StatusIcon status={points.status} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-black tabular-nums">
            +{points.points.toLocaleString()} {program.points_name}
          </p>
          <p className="truncate text-xs text-white/85">{earned ? t("rewards.pending.earnedAt", { program: program.name }) : pendingLine(points.status, t)}</p>
        </div>
      </Link>
    </motion.div>
  );
}
