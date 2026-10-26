import { Wallet, ShieldCheck, ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { getBalance } from "../../holochain/zomes/ledger";
import { getReputationSummary } from "../../holochain/zomes/reputation";
import { myAgentPubKey } from "../../holochain/client";
import { bytesToHex } from "../../holochain/decode";
import { useResource } from "../../lib/useResource";
import { Card, Skeleton, StatNumber } from "../../components/ui";
import { formatCents } from "../../lib/format";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import { EarningsReport } from "./EarningsReport";
import { useT } from "../../i18n";
import { useTerms } from "../../store/network";

export function Earnings() {
  const t = useT();
  const terms = useTerms();
  const me = myAgentPubKey();
  const meHex = bytesToHex(me);
  const { data: balance } = useResource(`balance:${meHex}`, () => getBalance(me));
  // Driver-scoped: deliveries only, never completions at a store this
  // agent might also run.
  const { data: rep } = useResource(`driver-rep:${meHex}`, () => getReputationSummary({ Driver: me }));

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4 pb-8">
      <motion.h1 variants={fadeSlideUp} className="mb-4 text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">
        {t("nav.earnings")}
      </motion.h1>

      <motion.div variants={fadeSlideUp}>
        <Card className="mb-4 flex items-center gap-3 p-5">
          <div className="grid h-11 w-11 place-items-center rounded-full bg-relay-100 dark:bg-relay-900/30 text-relay-600">
            <Wallet size={20} />
          </div>
          <div className="flex-1">
            <p className="text-xs text-ink-400">{t("wallet.balance")}</p>
            {balance === undefined ? <Skeleton className="mt-1 h-7 w-24" /> : <StatNumber className="text-2xl">{formatCents(balance)}</StatNumber>}
          </div>
          <Link to="/wallet" className="inline-flex items-center gap-1 rounded-full bg-relay-500 px-3.5 py-2 text-xs font-semibold text-white">
            <ArrowUpRight size={14} /> {t("wallet.cashOut")}
          </Link>
        </Card>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <EarningsReport meHex={meHex} />
      </motion.div>

      <motion.p variants={fadeSlideUp} className="mb-4 rounded-xl bg-ink-100/60 dark:bg-ink-800/60 px-4 py-3 text-xs text-ink-500 dark:text-ink-400">
        {t("earnings.note")}
      </motion.p>

      <motion.div variants={fadeSlideUp}>
        <Card className="p-5">
          <p className="mb-3 flex items-center gap-2 text-sm font-bold text-ink-900 dark:text-ink-50">
            <ShieldCheck size={16} className="text-presence-600" /> {t("earnings.reputation")}
          </p>
          <p className="-mt-2 mb-3 text-xs text-ink-400">{t("reputation.window", { count: terms.reputation_window_days })}</p>
          {rep === undefined ? (
            <div className="grid grid-cols-2 gap-3">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : (
            <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="grid grid-cols-2 gap-3 text-sm">
              <Stat label={t("earnings.completed")} value={rep.completed_count} tone="success" />
              <Stat label={t("earnings.cancelled")} value={rep.cancelled_by_them_count} />
              <Stat label={t("earnings.disputes")} value={rep.dispute_raised_count} />
              <Stat label={t("earnings.against")} value={rep.dispute_resolved_against_count} tone={rep.dispute_resolved_against_count > 0 ? "danger" : "default"} />
            </motion.div>
          )}
        </Card>
      </motion.div>
    </motion.div>
  );
}

function Stat({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "success" | "danger" }) {
  return (
    <motion.div variants={fadeSlideUp} className="rounded-xl bg-ink-50 dark:bg-ink-800/60 p-3">
      <StatNumber tone={tone} className="text-lg">{value}</StatNumber>
      <p className="text-xs text-ink-400">{label}</p>
    </motion.div>
  );
}
