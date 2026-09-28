import { useEffect, useState } from "react";
import { Wallet, ShieldCheck } from "lucide-react";
import { getBalance } from "../../holochain/zomes/ledger";
import { getReputationSummary } from "../../holochain/zomes/reputation";
import { myAgentPubKey } from "../../holochain/client";
import { Card, Spinner } from "../../components/ui";
import { formatCents } from "../../lib/format";
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
    <div className="px-4 pt-4 pb-8">
      <h1 className="mb-4 text-xl font-black text-ink-900 dark:text-ink-50">Earnings</h1>

      <Card className="mb-4 flex items-center gap-3 p-5">
        <div className="grid h-11 w-11 place-items-center rounded-full bg-relay-100 dark:bg-relay-900/30 text-relay-600">
          <Wallet size={20} />
        </div>
        <div>
          <p className="text-xs text-ink-400">Ledger balance</p>
          {balance === null ? <Spinner className="mt-1 h-4 w-4" /> : <p className="text-2xl font-black text-ink-900 dark:text-ink-50">{formatCents(balance)}</p>}
        </div>
      </Card>

      <p className="mb-4 rounded-xl bg-ink-100/60 dark:bg-ink-800/60 px-4 py-3 text-xs text-ink-500 dark:text-ink-400">
        This is a mutual-credit ledger, not a bank balance — a negative number means you currently owe the network, which nets
        out against someone else's positive balance elsewhere. It's a stand-in for HoloFuel, shaped the same way on purpose.
      </p>

      <Card className="p-5">
        <p className="mb-3 flex items-center gap-2 text-sm font-bold text-ink-900 dark:text-ink-50">
          <ShieldCheck size={16} className="text-presence-600" /> Reputation
        </p>
        {rep === null ? (
          <Spinner className="h-4 w-4" />
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Stat label="Completed" value={rep.completed_count} />
            <Stat label="Cancelled by them" value={rep.cancelled_by_them_count} />
            <Stat label="Disputes raised" value={rep.dispute_raised_count} />
            <Stat label="Resolved against you" value={rep.dispute_resolved_against_count} />
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-ink-50 dark:bg-ink-800/60 p-3">
      <p className="text-lg font-black text-ink-900 dark:text-ink-50">{value}</p>
      <p className="text-xs text-ink-400">{label}</p>
    </div>
  );
}
