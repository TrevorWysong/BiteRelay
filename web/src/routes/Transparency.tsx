import { ArrowDownCircle, ArrowUpCircle, Lock, ShieldCheck } from "lucide-react";
import { motion } from "framer-motion";
import { useSession } from "../store/session";
import { listMyLedger, getBalance } from "../holochain/zomes/ledger";
import { decodeEntry, actionHash, bytesToHex, timestampOf } from "../holochain/decode";
import { Card, Skeleton, StatNumber } from "../components/ui";
import { formatCents, timeAgo } from "../lib/ui/format";
import { fadeSlideUp, staggerContainer } from "../lib/ui/motion";
import { useResource } from "../lib/hooks/useResource";
import type { LedgerEntry } from "../holochain/types";
import { describeLedgerEntry } from "../lib/money/ledger";
import { useT } from "../i18n";

interface Row {
  hash: Uint8Array;
  entry: LedgerEntry;
  at: number;
}

/// The "no-skim" transparency dashboard: every entry on this agent's own
/// ledger -- each hold, collection and deposit, with the balance it left
/// them -- straight from their own signed chain, newest first. Each entry's
/// balance follows from the one before it (validation checks), so this
/// page is the whole account, not a report about it. There is no operator
/// account anywhere in this system for a platform cut to go to.
export function Transparency() {
  const t = useT();
  const agentPubKey = useSession((s) => s.agentPubKey);
  const agentHex = agentPubKey ? bytesToHex(agentPubKey) : null;
  const { data: balance } = useResource(agentHex && `balance:${agentHex}`, () => getBalance(agentPubKey!).catch(() => 0));
  const { data: rows } = useResource<Row[]>(agentHex && `ledger:${agentHex}`, () =>
    listMyLedger(null)
      .then((page) => page.entries.map((r) => ({ hash: actionHash(r), entry: decodeEntry<LedgerEntry>(r), at: timestampOf(r) })))
      .catch(() => []),
  );

  if (!agentPubKey || rows === undefined) {
    return (
      <div className="px-4 pb-10 pt-4">
        <Skeleton className="h-44 w-full rounded-3xl mb-5" />
        <div className="mb-5 grid grid-cols-3 gap-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
        <Skeleton className="h-24 w-full mb-3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const totalReceived = rows.filter((r) => describeLedgerEntry(r.entry).direction === "in").reduce((sum, r) => sum + r.entry.amount, 0);
  const totalPaid = rows.filter((r) => describeLedgerEntry(r.entry).direction === "out").reduce((sum, r) => sum + r.entry.amount, 0);
  const flowTotal = totalReceived + totalPaid;
  const receivedShare = flowTotal > 0 ? (totalReceived / flowTotal) * 100 : 50;

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.div
        variants={fadeSlideUp}
        className="relative mb-5 flex flex-col items-center gap-2 overflow-hidden rounded-3xl bg-gradient-to-br from-handshake-500 to-presence-500 p-6 text-center text-white shadow-[var(--shadow-float)]"
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 15%, rgba(255,255,255,0.25) 0%, transparent 45%), radial-gradient(circle at 85% 85%, rgba(255,255,255,0.15) 0%, transparent 40%)",
          }}
        />
        <motion.div animate={{ scale: [1, 1.08, 1] }} transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }} className="relative">
          <ShieldCheck size={30} />
        </motion.div>
        <p className="relative text-4xl font-black tracking-tight">{formatCents(0)}</p>
        <p className="relative text-sm font-bold opacity-95">{t("transparency.zero")}</p>
        <p className="relative mt-1 max-w-xs text-xs leading-relaxed opacity-80">
          {t("transparency.detail")}
        </p>
      </motion.div>

      <motion.div variants={fadeSlideUp} className="mb-2 grid grid-cols-3 gap-2">
        <Card className="p-3 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t("transparency.received")}</p>
          <StatNumber tone="success" className="text-lg">{formatCents(totalReceived)}</StatNumber>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t("transparency.setAside")}</p>
          <StatNumber className="text-lg">{formatCents(totalPaid)}</StatNumber>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t("transparency.net")}</p>
          <StatNumber tone={(balance ?? 0) >= 0 ? "success" : "danger"} className="text-lg">{formatCents(balance ?? 0)}</StatNumber>
        </Card>
      </motion.div>

      {flowTotal > 0 && (
        <motion.div variants={fadeSlideUp} className="mb-5">
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${receivedShare}%` }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              className="bg-presence-500"
            />
          </div>
          <div className="mt-1 flex justify-between text-[10px] font-semibold text-ink-400">
            <span>{t("transparency.receivedShare", { percent: receivedShare.toFixed(0) })}</span>
            <span>{t("transparency.paidShare", { percent: (100 - receivedShare).toFixed(0) })}</span>
          </div>
        </motion.div>
      )}

      <motion.h2 variants={fadeSlideUp} className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">
        {t("transparency.entries")}
      </motion.h2>
      {rows.length === 0 && (
        <motion.p variants={fadeSlideUp} className="rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 text-center text-sm text-ink-400">
          {t("transparency.empty")}
        </motion.p>
      )}
      <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="pb-6">
        <Card className="flex flex-col gap-3 p-4">
          {rows.map((row) => {
            const { label, direction } = describeLedgerEntry(row.entry);
            const Icon = direction === "in" ? ArrowDownCircle : direction === "out" ? Lock : ArrowUpCircle;
            return (
              <motion.div variants={fadeSlideUp} key={bytesToHex(row.hash)} className="flex items-center gap-2.5">
                <Icon size={18} className={direction === "in" ? "shrink-0 text-presence-600" : "shrink-0 text-ink-400"} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{label}</p>
                  <p className="text-xs text-ink-400">
                    {timeAgo(row.at)} · balance {formatCents(row.entry.balance)}
                  </p>
                </div>
                {direction !== "none" && (
                  <StatNumber tone={direction === "in" ? "success" : "default"} className="text-sm">
                    {direction === "in" ? "+" : "−"}
                    {formatCents(row.entry.amount)}
                  </StatNumber>
                )}
              </motion.div>
            );
          })}
        </Card>
      </motion.div>
    </motion.div>
  );
}
