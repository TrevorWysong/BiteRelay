import { useEffect, useState } from "react";
import { Wallet, ShieldCheck } from "lucide-react";
import { motion } from "framer-motion";
import { getBalance } from "../../holochain/zomes/ledger";
import { getReputationSummary } from "../../holochain/zomes/reputation";
import { myAgentPubKey } from "../../holochain/client";
import { Card, Skeleton, StatNumber } from "../../components/ui";
import { formatCents } from "../../lib/format";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import type { ReputationSummary } from "../../holochain/types";

export function Earnings() {
  const [balance, setBalance] = useState<number | null>(null);
  const [rep, setRep] = useState<ReputationSummary | null>(null);

  useEffect(() => {
    const me = myAgentPubKey();
    getBalance(me).then(setBalance);
    getReputationSummary(me).then(setRep);
  }, []);

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4 pb-8">
      <motion.h1 variants={fadeSlideUp} className="mb-4 text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">
        Earnings
      </motion.h1>

      <motion.div variants={fadeSlideUp}>
        <Card className="mb-4 flex items-center gap-3 p-5">
          <div className="grid h-11 w-11 place-items-center rounded-full bg-relay-100 dark:bg-relay-900/30 text-relay-600">
            <Wallet size={20} />
          </div>
          <div>
            <p className="text-xs text-ink-400">Ledger balance</p>
            {balance === null ? <Skeleton className="mt-1 h-7 w-24" /> : <StatNumber className="text-2xl">{formatCents(balance)}</StatNumber>}
          </div>
        </Card>
      </motion.div>

      <motion.p variants={fadeSlideUp} className="mb-4 rounded-xl bg-ink-100/60 dark:bg-ink-800/60 px-4 py-3 text-xs text-ink-500 dark:text-ink-400">
        This is a mutual-credit ledger, not a bank balance. A negative number means you currently owe the network, which nets
        out against someone else's positive balance elsewhere. It's a stand-in for HoloFuel, shaped the same way on purpose.
      </motion.p>

      <motion.div variants={fadeSlideUp}>
        <Card className="p-5">
          <p className="mb-3 flex items-center gap-2 text-sm font-bold text-ink-900 dark:text-ink-50">
            <ShieldCheck size={16} className="text-presence-600" /> Reputation
          </p>
          {rep === null ? (
            <div className="grid grid-cols-2 gap-3">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : (
            <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Completed" value={rep.completed_count} tone="success" />
              <Stat label="Cancelled by them" value={rep.cancelled_by_them_count} />
              <Stat label="Disputes raised" value={rep.dispute_raised_count} />
              <Stat label="Resolved against you" value={rep.dispute_resolved_against_count} tone={rep.dispute_resolved_against_count > 0 ? "danger" : "default"} />
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
