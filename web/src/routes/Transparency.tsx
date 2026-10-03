import { useEffect, useState } from "react";
import { ArrowDownCircle, ArrowUpCircle, ShieldCheck } from "lucide-react";
import { useSession } from "../store/session";
import { listMyTransactions, getBalance } from "../holochain/zomes/ledger";
import { decodeEntry, actionHash, bytesEqual, bytesToHex } from "../holochain/decode";
import { Card, Spinner } from "../components/ui";
import { formatCents, timeAgo } from "../lib/format";
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
      <div className="flex justify-center py-16 text-ink-300">
        <Spinner />
      </div>
    );
  }

  const totalReceived = rows.filter((r) => bytesEqual(r.txn.to, agentPubKey)).reduce((s, r) => s + r.txn.amount, 0);
  const totalPaid = rows.filter((r) => bytesEqual(r.txn.from, agentPubKey)).reduce((s, r) => s + r.txn.amount, 0);

  const byOrder = new Map<string, Row[]>();
  for (const row of rows) {
    const key = bytesToHex(row.txn.related_order);
    byOrder.set(key, [...(byOrder.get(key) ?? []), row]);
  }
  const orderGroups = [...byOrder.entries()].sort(
    (a, b) => Math.max(...b[1].map((r) => r.txn.created_at)) - Math.max(...a[1].map((r) => r.txn.created_at)),
  );

  return (
    <div className="px-4 pb-10 pt-4">
      <div className="mb-5 flex flex-col items-center gap-2 rounded-3xl bg-gradient-to-br from-relay-500 to-presence-500 p-6 text-center text-white shadow-lg">
        <ShieldCheck size={30} />
        <p className="text-4xl font-black tracking-tight">$0.00</p>
        <p className="text-sm font-bold opacity-95">Platform fee taken from your orders — always, by design.</p>
        <p className="mt-1 max-w-xs text-xs leading-relaxed opacity-80">
          Every cent you've ever paid or been paid through Relay is listed below, straight from your own cryptographically
          signed ledger entries — not a report we generated, the actual data. There's no operator account anywhere in this
          system for a cut to go to, so there's nothing to hide here.
        </p>
      </div>

      <div className="mb-5 grid grid-cols-3 gap-2">
        <Card className="p-3 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Received</p>
          <p className="text-lg font-black text-presence-600">{formatCents(totalReceived)}</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Paid</p>
          <p className="text-lg font-black text-ink-900 dark:text-ink-50">{formatCents(totalPaid)}</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Net</p>
          <p className={`text-lg font-black ${(balance ?? 0) >= 0 ? "text-presence-600" : "text-red-500"}`}>{formatCents(balance ?? 0)}</p>
        </Card>
      </div>

      <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">Every transaction, by order</h2>
      {orderGroups.length === 0 && (
        <p className="rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 text-center text-sm text-ink-400">
          Nothing here yet — place or complete an order to see it appear.
        </p>
      )}
      <div className="flex flex-col gap-3 pb-6">
        {orderGroups.map(([orderHex, group]) => (
          <Card key={orderHex} className="p-4">
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
                      <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">
                        {received ? "Received" : "Paid"} {formatCents(row.txn.amount)}
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
        ))}
      </div>
    </div>
  );
}
