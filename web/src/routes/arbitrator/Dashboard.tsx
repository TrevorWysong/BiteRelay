// The arbitrator side of dispute/arbitration (architecture plan §8/§11.1).
// Only reachable if `governance.ts` found this agent's pubkey on the DNA
// property roster -- `dispute_integrity::validate()` is the real
// enforcement either way, this screen just gives an actual arbitrator
// somewhere to review and rule on the cases the network sees.
import { useCallback, useState } from "react";
import { usePolling } from "../../lib/useResource";
import { Gavel } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { listOpenDisputes, submitResolution } from "../../holochain/zomes/dispute";
import { getOrder, applyDisputeResolution, applyCancellationDisputeResolution, checkDeliveryPin } from "../../holochain/zomes/dispatch";
import { getLegsForOrder, getSharedEvidence } from "../../holochain/zomes/attestation";
import { CustomerHistory } from "../../components/CustomerHistory";
import { useResource } from "../../lib/useResource";
import { distanceKm, geohashCenter } from "../../lib/geohash";
import { decodeEntry, actionHash, bytesToHex } from "../../holochain/decode";
import { Button, Card, Skeleton, EmptyState, Badge, StatNumber, Textarea } from "../../components/ui";
import { formatCents, shortAgentId, timeAgo } from "../../lib/format";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import { describeError } from "../../lib/errors";
import type { Dispute, DeliveryOrder, Leg, PinVerdict } from "../../holochain/types";
import { POLL } from "../../lib/poll";

interface CaseRow {
  hash: Uint8Array;
  dispute: Dispute;
  order: DeliveryOrder | null;
}


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

  // Nothing signals an arbitrator about a new case.
  usePolling(refresh, { pollMs: POLL.unsignalled });

  async function resolve(row: CaseRow, favor: "provider" | "requester", reasoning: string) {
    setError(null);
    try {
      const outcome = favor === "provider" ? "FavorProvider" : "FavorRequester";
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
      setError(describeError(err));
      throw err;
    }
  }

  if (cases === null) {
    return (
      <div className="px-4 pb-10 pt-4">
        <Skeleton className="h-7 w-1/3 mb-4" />
        <Skeleton className="h-40 w-full mb-3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.h1 variants={fadeSlideUp} className="mb-4 text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">
        Open cases
      </motion.h1>
      {cases.length === 0 && (
        <motion.div variants={fadeSlideUp}>
          <EmptyState icon={<Gavel size={32} />} title="No open disputes" subtitle="Cases raised by either party will show up here for you to review." />
        </motion.div>
      )}
      <div className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {cases.map((row) => (
            <motion.div key={bytesToHex(row.hash)} layout variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0 }}>
              <CaseCard row={row} onResolve={(favor, reasoning) => resolve(row, favor, reasoning)} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </motion.div>
  );
}

function CaseCard({
  row,
  onResolve,
}: {
  row: CaseRow;
  onResolve: (favor: "provider" | "requester", reasoning: string) => Promise<void>;
}) {
  const { dispute, order } = row;
  const isCancellation = dispute.reason === "UnjustCancellation";
  const [reasoning, setReasoning] = useState("");
  const [resolving, setResolving] = useState(false);

  async function handle(favor: "provider" | "requester") {
    setResolving(true);
    try {
      await onResolve(favor, reasoning.trim());
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
        <p className="flex items-baseline gap-1 text-sm font-semibold text-ink-900 dark:text-ink-50">
          <StatNumber className="text-sm">{formatCents(order.order_total)}</StatNumber> order &middot; currently {order.status}
        </p>
      )}
      <p className="text-sm text-ink-600 dark:text-ink-300">{dispute.description}</p>
      {order && <CaseEvidence orderRef={dispute.order_ref} order={order} />}
      <p className="text-xs text-ink-400">
        Raised by {shortAgentId(dispute.raised_by)} against {shortAgentId(dispute.respondent)}
        {dispute.evidence_refs.length > 0 && ` · ${dispute.evidence_refs.length} evidence item${dispute.evidence_refs.length === 1 ? "" : "s"}`}
      </p>

      {!order ? (
        <p className="rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Couldn't load this order yet. This refreshes automatically, so try again shortly.
        </p>
      ) : (
        <div className="mt-1 flex flex-col gap-2 rounded-xl bg-ink-50 dark:bg-ink-800/60 p-3">
          {/* A ruling moves no money itself: it settles what was set aside as the order went. */}
          <p className="text-[11px] leading-relaxed text-ink-400">
            Favoring the provider pays the order as if it were delivered, and returns the driver's collateral. Favoring the
            customer returns everything they set aside{isCancellation ? "" : `, and gives the store the driver's collateral (${formatCents(order.order_total)}) for the food it handed over`}.
          </p>
          <label className="text-xs font-semibold text-ink-500">Reasoning</label>
          <Textarea value={reasoning} onChange={(e) => setReasoning(e.target.value)} rows={2} placeholder="Why you're ruling this way. This is recorded permanently." />
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

const PIN_VERDICT: Record<PinVerdict, { text: string; tone: "success" | "danger" | "warn" | "neutral" }> = {
  Matches: { text: "The driver collected the customer's PIN: they were there.", tone: "success" },
  CustomerTampered: { text: "The customer's sealed PIN doesn't match their own commitment: they tampered with it.", tone: "success" },
  Mismatch: { text: "The PIN the driver recorded isn't the customer's.", tone: "danger" },
  NotCollected: { text: "No PIN was collected at the door.", tone: "neutral" },
};

/// What an arbitrator has to go on for a delivery: the PIN check, the
/// driver's evidence (if a party shared it), and the customer's record.
function CaseEvidence({ orderRef, order }: { orderRef: Uint8Array; order: DeliveryOrder }) {
  const hex = bytesToHex(orderRef);
  const { data: verdict } = useResource(`pin-verdict:${hex}`, () => checkDeliveryPin(orderRef).catch(() => null));
  const { data: evidence } = useResource(`shared-evidence:${hex}`, async () => {
    const dropoff = (await getLegsForOrder(orderRef)).find((r) => decodeEntry<Leg>(r).kind === "CustomerHandoff");
    return dropoff ? getSharedEvidence(actionHash(dropoff)) : null;
  });
  const pin = verdict ? PIN_VERDICT[verdict] : null;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-ink-100 p-3 dark:border-ink-800">
      <p className="text-[11px] font-bold uppercase tracking-wide text-ink-400">Evidence</p>
      {pin && <Badge tone={pin.tone}>{pin.text}</Badge>}
      {evidence ? (
        <>
          {evidence.photo_data_uri && <img src={evidence.photo_data_uri} alt="The driver's photo at the drop-off" className="max-h-56 w-full rounded-lg object-cover" />}
          <p className="text-xs text-ink-400">
            Recorded {evidence.geo.lat.toFixed(5)}, {evidence.geo.lon.toFixed(5)}
            {order.dropoff_geohash && ` (${distanceKm(evidence.geo, geohashCenter(order.dropoff_geohash)).toFixed(1)} km from the drop-off area)`}
          </p>
        </>
      ) : (
        <p className="text-xs text-ink-400">Neither party has shared the drop-off's photo or location.</p>
      )}
      <CustomerHistory customer={order.requester} />
    </div>
  );
}
