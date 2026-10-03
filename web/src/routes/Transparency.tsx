import { useEffect, useState } from "react";
import { ArrowDownCircle, ArrowUpCircle, ShieldCheck } from "lucide-react";
import { motion } from "framer-motion";
import { useSession } from "../store/session";
import { listMyTransactions, getBalance } from "../holochain/zomes/ledger";
import { decodeEntry, actionHash, bytesEqual, bytesToHex } from "../holochain/decode";
import { Card, Skeleton, StatNumber } from "../components/ui";
import { formatCents, timeAgo } from "../lib/format";
import { fadeSlideUp, staggerContainer } from "../lib/motion";
import type { LedgerTransaction } from "../holochain/types";

interface Row {
  hash: Uint8Array;
  txn: LedgerTransaction;
}

/// The "no-skim" transparency dashboard: every ledger transaction this
/// agent has ever been a party to, straight from their own cryptographic
/// chain, grouped by order. Deliberately a *personal* ledger, not a
/// network-wide one -- Holochain's agent-centric model means there's no
/// global transaction feed to query in the first place (every discovery
/// read in this app is already scoped this way, see architecture plan
/// §9), and a personal "where did my money go" proof is actually the
/// stronger claim: it's independently verifiable from data this agent
/// already holds, not something anyone has to trust a dashboard's own
/// aggregation of. There is no operator account anywhere in this
/// system's data model for a platform cut to land in -- not hidden, not
/// omitted from this view, structurally absent from the ledger itself.
export function Transparency() {
  const agentPubKey = useSession((s) => s.agentPubKey);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    if (!agentPubKey) return;
    getBalance(agentPubKey).then(setBalance).catch(() => setBalance(0));
    listMyTransactions(null)
      .then((page) => setRows(page.transactions.map((r) => ({ hash: actionHash(r), txn: decodeEntry<LedgerTransaction>(r) }))))
      .catch(() => setRows([]));
  }, [agentPubKey]);

  if (!agentPubKey || rows === null) {
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

  const totalReceived = rows.filter((r) => bytesEqual(r.txn.to, agentPubKey)).reduce((s, r) => s + r.txn.amount, 0);
  const totalPaid = rows.filter((r) => bytesEqual(r.txn.from, agentPubKey)).reduce((s, r) => s + r.txn.amount, 0);
  const flowTotal = totalReceived + totalPaid;
  const receivedShare = flowTotal > 0 ? (totalReceived / flowTotal) * 100 : 50;

  const byOrder = new Map<string, Row[]>();
  for (const row of rows) {
    const key = bytesToHex(row.txn.related_order);
    byOrder.set(key, [...(byOrder.get(key) ?? []), row]);
  }
  const orderGroups = [...byOrder.entries()].sort(
    (a, b) => Math.max(...b[1].map((r) => r.txn.created_at)) - Math.max(...a[1].map((r) => r.txn.created_at)),
  );

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.div
        variants={fadeSlideUp}
        className="relative mb-5 flex flex-col items-center gap-2 overflow-hidden rounded-3xl bg-gradient-to-br from-relay-500 to-presence-500 p-6 text-center text-white shadow-[var(--shadow-float)]"
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
        <p className="relative text-4xl font-black tracking-tight">$0.00</p>
        <p className="relative text-sm font-bold opacity-95">Platform fee taken from your orders — always, by design.</p>
        <p className="relative mt-1 max-w-xs text-xs leading-relaxed opacity-80">
          Every cent you've ever paid or been paid through Relay is listed below, straight from your own cryptographically
          signed ledger entries — not a report we generated, the actual data. There's no operator account anywhere in this
          system for a cut to go to, so there's nothing to hide here.
        </p>
      </motion.div>

      <motion.div variants={fadeSlideUp} className="mb-2 grid grid-cols-3 gap-2">
        <Card className="p-3 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Received</p>
          <StatNumber tone="success" className="text-lg">{formatCents(totalReceived)}</StatNumber>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Paid</p>
          <StatNumber className="text-lg">{formatCents(totalPaid)}</StatNumber>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Net</p>
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
            <span>{receivedShare.toFixed(0)}% received</span>
            <span>{(100 - receivedShare).toFixed(0)}% paid</span>
          </div>
        </motion.div>
      )}

      <motion.h2 variants={fadeSlideUp} className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">
        Every transaction, by order
      </motion.h2>
      {orderGroups.length === 0 && (
        <motion.p variants={fadeSlideUp} className="rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 text-center text-sm text-ink-400">
          Nothing here yet — place or complete an order to see it appear.
        </motion.p>
      )}
      <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="flex flex-col gap-3 pb-6">
        {orderGroups.map(([orderHex, group]) => (
          <motion.div variants={fadeSlideUp} key={orderHex}>
            <Card className="p-4">
              <p className="mb-2 font-mono text-[11px] text-ink-400">Order #{orderHex.slice(0, 10)}</p>
              <div className="flex flex-col gap-2.5">
                {group.map((row) => {
                  const received = bytesEqual(row.txn.to, agentPubKey);
                  return (
                    <div key={bytesToHex(row.hash)} className="flex items-center gap-2.5">
                      {received ? (
                        <ArrowDownCircle size={18} className="shrink-0 text-presence-600" />
                      ) : (
                        <ArrowUpCircle size={18} className="shrink-0 text-ink-400" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="flex items-baseline gap-1 text-sm font-semibold text-ink-900 dark:text-ink-50">
                          {received ? "Received" : "Paid"} <StatNumber tone={received ? "success" : "default"} className="text-sm">{formatCents(row.txn.amount)}</StatNumber>
                        </p>
                        <p className="text-xs text-ink-400">
                          {row.txn.reason === "CollateralForfeit" ? "Collateral forfeiture" : "Order payment"} · {timeAgo(row.txn.created_at)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          </motion.div>
        ))}
      </motion.div>
    </motion.div>
  );
}
