// The arbitrator side of dispute/arbitration (architecture plan §8/§11.1).
// Only reachable if `governance.ts` found this agent's pubkey on the DNA
// property roster -- `dispute_integrity::validate()` is the real
// enforcement either way, this screen just gives an actual arbitrator
// somewhere to review and rule on the cases the network sees.
import { useCallback, useEffect, useState } from "react";
import { Gavel } from "lucide-react";
import { listOpenDisputes, submitResolution } from "../../holochain/zomes/dispute";
import { getOrder, applyDisputeResolution, applyCancellationDisputeResolution } from "../../holochain/zomes/dispatch";
import { decodeEntry, actionHash, bytesToHex } from "../../holochain/decode";
import { Button, Card, Spinner, EmptyState, Badge } from "../../components/ui";
import { formatCents, shortAgentId, timeAgo } from "../../lib/format";
import type { Dispute, DeliveryOrder } from "../../holochain/types";

interface CaseRow {
  hash: Uint8Array;
  dispute: Dispute;
  order: DeliveryOrder | null;
}

const POLL_MS = 8000;

export function ArbitratorDashboard() {
  const [cases, setCases] = useState<CaseRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const page = await listOpenDisputes();
    const rows = await Promise.all(
      page.disputes.map(async (record) => {
        const dispute = decodeEntry<Dispute>(record);
        let order: DeliveryOrder | null = null;
        try {
          order = decodeEntry<DeliveryOrder>(await getOrder(dispute.order_ref));
        } catch {
          // Order somehow unreachable right now -- still list the case, the
          // card below just disables resolution until a refresh finds it.
        }
        return { hash: actionHash(record), dispute, order };
      }),
    );
    setCases(rows);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  async function resolve(row: CaseRow, favor: "provider" | "requester", forfeitAmount: number, reasoning: string) {
    setError(null);
    try {
      const outcome = favor === "provider" ? { FavorProvider: { forfeit_amount: forfeitAmount } } : { FavorRequester: { forfeit_amount: forfeitAmount } };
      await submitResolution({ dispute_original_action: row.hash, outcome, reasoning });
      // Which apply-fn depends on whether this was a normal completion
      // dispute (order still `Disputed`) or a cancellation-fairness one
      // (order was already `Cancelled` when raised) -- see plan §11.1.
      if (row.order?.status === "Cancelled") {
        await applyCancellationDisputeResolution(row.dispute.order_ref);
      } else {
        await applyDisputeResolution(row.dispute.order_ref);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  if (cases === null) {
    return (
      <div className="flex justify-center py-16 text-ink-300">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="px-4 pb-10 pt-4">
      <h1 className="mb-4 text-xl font-black text-ink-900 dark:text-ink-50">Open cases</h1>
      {cases.length === 0 && (
        <EmptyState icon={<Gavel size={32} />} title="No open disputes" subtitle="Cases raised by either party will show up here for you to review." />
      )}
      <div className="flex flex-col gap-3">
        {cases.map((row) => (
          <CaseCard key={bytesToHex(row.hash)} row={row} onResolve={(favor, amount, reasoning) => resolve(row, favor, amount, reasoning)} />
        ))}
      </div>
      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}

function CaseCard({
  row,
  onResolve,
}: {
  row: CaseRow;
  onResolve: (favor: "provider" | "requester", forfeitAmount: number, reasoning: string) => Promise<void>;
}) {
  const { dispute, order } = row;
  const isCancellation = dispute.reason === "UnjustCancellation";
  const [forfeitAmount, setForfeitAmount] = useState(0);
  const [reasoning, setReasoning] = useState("");
  const [resolving, setResolving] = useState(false);

  async function handle(favor: "provider" | "requester") {
    setResolving(true);
    try {
      await onResolve(favor, forfeitAmount, reasoning.trim());
    } catch {
      // error already surfaced by the parent's own error state
    } finally {
      setResolving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <Badge tone={isCancellation ? "warn" : "danger"}>{dispute.reason.replace(/([A-Z])/g, " $1").trim()}</Badge>
        <span className="text-xs text-ink-400">{timeAgo(dispute.raised_at)}</span>
      </div>
      {order && (
        <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">
          {formatCents(order.order_total)} order &middot; currently {order.status}
        </p>
      )}
      <p className="text-sm text-ink-600 dark:text-ink-300">{dispute.description}</p>
      <p className="text-xs text-ink-400">
        Raised by {shortAgentId(dispute.raised_by)} against {shortAgentId(dispute.respondent)}
        {dispute.evidence_refs.length > 0 && ` · ${dispute.evidence_refs.length} evidence ref${dispute.evidence_refs.length === 1 ? "" : "s"}`}
      </p>

      {!order ? (
        <p className="rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Could not load the underlying order -- this refreshes automatically, try again shortly.
        </p>
      ) : (
        <div className="mt-1 flex flex-col gap-2 rounded-xl bg-ink-50 dark:bg-ink-800/60 p-3">
          <label className="text-xs font-semibold text-ink-500">Forfeit amount (cents, charged to the losing party)</label>
          <input
            type="number"
            min={0}
            value={forfeitAmount}
            onChange={(e) => setForfeitAmount(Math.max(0, Number(e.target.value) || 0))}
            className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
          />
          <label className="text-xs font-semibold text-ink-500">Reasoning</label>
          <textarea
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value)}
            rows={2}
            placeholder="Why you're ruling this way -- recorded on-chain."
            className="resize-none rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
          />
          <div className="mt-1 flex gap-2">
            <Button variant="secondary" className="flex-1 px-3 py-2 text-xs" loading={resolving} disabled={!reasoning.trim()} onClick={() => handle("provider")}>
              {isCancellation ? "Compensate provider" : "Favor provider"}
            </Button>
            <Button variant="ghost" className="flex-1 px-3 py-2 text-xs" loading={resolving} disabled={!reasoning.trim()} onClick={() => handle("requester")}>
              {isCancellation ? "Dismiss, no fault" : "Favor requester"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
