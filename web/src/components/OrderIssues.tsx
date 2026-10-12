// Missing and wrong items, once the customer has their order: they report
// them, the store accepts or declines each report (its answer is final),
// and when their report window has run the store's app settles the food --
// refunding what it accepted or never answered (see the dispatch `issues`
// module). Shown on both sides of the order.
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, Clock3, Minus, PackageX, Plus, Repeat2, ShieldCheck, XCircle } from "lucide-react";
import { getIssueItems, getIssuesForOrder, getOrderDecisions, reportIssue, respondToIssue } from "../holochain/zomes/dispatch";
import { bytesToHex } from "../holochain/decode";
import { MAX_NOTE_CHARS, type IssueItems, type IssueKind, type IssueLine, type IssueView, type OrderDecisions } from "../holochain/types";
import { claimedValue } from "../lib/issues";
import { describeError } from "../lib/errors";
import { formatCents, formatDeadline, timeAgo } from "../lib/format";
import { POLL } from "../lib/poll";
import { useClock } from "../lib/useClock";
import { useResource } from "../lib/useResource";
import { Button, Card, Textarea } from "./ui";
import { PhotoInput } from "./PhotoInput";
import { Sheet } from "./Sheet";

type Role = "customer" | "store";

const KIND_LABEL: Record<IssueKind, string> = { Missing: "Missing", Wrong: "Wrong item" };

export function OrderIssues({ orderRef, role }: { orderRef: Uint8Array; role: Role }) {
  const hex = bytesToHex(orderRef);
  const refresh = { pollMs: POLL.unsignalled, refreshOn: (s: object) => "IssueReported" in s || "OrderUpdated" in s || "OrderChanged" in s };
  const { data: decisions } = useResource(`order-decisions:${hex}`, () => getOrderDecisions(orderRef), refresh);
  const { data: issues, reload } = useResource(`issues:${hex}`, () => getIssuesForOrder(orderRef), refresh);
  const { data: items } = useResource(`issue-items:${hex}`, () => getIssueItems(orderRef));
  const [reporting, setReporting] = useState(false);
  const now = useClock(30_000).getTime() * 1000;

  if (!decisions || !issues || !items || decisions.not_delivered) return null;
  const open = decisions.refund === null;
  // The report window's run its course; the store's app is settling it.
  const settling = open && decisions.reports_until !== null && now >= decisions.reports_until;
  if (!open && issues.length === 0) return null;
  if (role === "store" && issues.length === 0) return <StorePayoutNote decisions={decisions} orderTotal={items.order_total} />;

  return (
    <Card className="mt-4 overflow-hidden">
      <div className="flex items-start gap-3 p-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-relay-50 text-relay-600 dark:bg-relay-900/30 dark:text-relay-400">
          <PackageX size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-ink-900 dark:text-ink-50">{headline(role, decisions, issues.length, settling)}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-500 dark:text-ink-400">{subline(role, decisions, settling)}</p>
        </div>
      </div>

      {issues.length > 0 && (
        <ul className="divide-y divide-ink-100 border-t border-ink-100 dark:divide-ink-800 dark:border-ink-800">
          {issues.map((issue) => (
            <IssueRow key={bytesToHex(issue.issue)} issue={issue} items={items} role={role} canAnswer={role === "store" && open} onAnswered={reload} />
          ))}
        </ul>
      )}

      {role === "customer" && open && !settling && (
        <div className="border-t border-ink-100 p-4 dark:border-ink-800">
          <Button variant="ghost" className="w-full" onClick={() => setReporting(true)}>
            {issues.length ? "Report something else" : "Report missing or wrong items"}
          </Button>
        </div>
      )}

      {role === "customer" && (
        <ReportIssueSheet
          open={reporting}
          onClose={() => setReporting(false)}
          orderRef={orderRef}
          items={items}
          alreadyReported={issues}
          onReported={async () => {
            setReporting(false);
            await reload();
          }}
        />
      )}
    </Card>
  );
}

function headline(role: Role, decisions: OrderDecisions, count: number, settling: boolean): string {
  const refund = decisions.refund;
  if (refund !== null) return refund > 0 ? `${formatCents(refund)} refunded for missing or wrong items` : role === "store" ? "Settled: no refund" : "The store declined your report";
  if (settling) return "Settling reports";
  if (role === "store") return count === 1 ? "The customer reported a problem" : `The customer reported ${count} problems`;
  return count ? "Your report is in" : "Missing or wrong items?";
}

function subline(role: Role, decisions: OrderDecisions, settling: boolean): string {
  if (decisions.refund !== null) return role === "customer" ? "Returned to your balance." : "The rest of the food's payment is yours.";
  if (settling) return "The report window has closed. Refunds are issued within a few minutes.";
  const until = decisions.reports_until !== null ? formatDeadline(decisions.reports_until) : null;
  if (role === "store") return `Accept or decline each report${until ? ` by ${until}` : ""}. Your answer is final; reports you don't answer are refunded.`;
  return until
    ? `You can report problems until ${until}. The store reviews each report and has the final say; refunds are issued when that window closes.`
    : "You can report problems for a while after your order arrives. The store reviews each report and has the final say.";
}

function StorePayoutNote({ decisions, orderTotal }: { decisions: OrderDecisions; orderTotal: number }) {
  if (decisions.refund !== null || decisions.reports_until === null) return null;
  return (
    <p className="mt-4 flex items-center gap-2 rounded-2xl bg-ink-50 px-4 py-3 text-xs text-ink-600 dark:bg-ink-800/60 dark:text-ink-300">
      <Clock3 size={14} className="shrink-0 text-ink-400" />
      {formatCents(orderTotal)} for the food is released at {formatDeadline(decisions.reports_until)}, once the customer's window to report problems closes.
    </p>
  );
}

function IssueRow({ issue, items, role, canAnswer, onAnswered }: { issue: IssueView; items: IssueItems; role: Role; canAnswer: boolean; onAnswered: () => Promise<void> }) {
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOf = (line: number) => {
    const ordered = items.lines[line];
    return ordered ? [ordered.name, ...ordered.choices].join(", ") : "An item";
  };

  async function answer(accept: boolean) {
    setBusy(accept ? "accept" : "decline");
    setError(null);
    try {
      await respondToIssue(issue.issue, accept);
      await onAnswered();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="p-4">
      <div className="flex items-start justify-between gap-3">
        <ul className="flex min-w-0 flex-col gap-1.5">
          {issue.lines.map((line) => (
            <li key={line.line} className="flex items-center gap-2 text-sm">
              <span className="font-semibold tabular-nums text-ink-900 dark:text-ink-50">{line.quantity}×</span>
              <span className="truncate text-ink-800 dark:text-ink-100">{nameOf(line.line)}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${line.kind === "Missing" ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200" : "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-200"}`}>
                {KIND_LABEL[line.kind]}
              </span>
            </li>
          ))}
        </ul>
        <span className="shrink-0 text-sm font-bold tabular-nums text-ink-900 dark:text-ink-50">{formatCents(issue.value)}</span>
      </div>

      {issue.evidence && (issue.evidence.note || issue.evidence.photo_data_uri) && (
        <div className="mt-3 flex gap-3 rounded-xl bg-ink-50 p-3 dark:bg-ink-800/60">
          {issue.evidence.photo_data_uri && <img src={issue.evidence.photo_data_uri} alt="Photo from the customer" className="h-16 w-16 shrink-0 rounded-lg object-cover" />}
          {issue.evidence.note && <p className="text-xs leading-relaxed text-ink-600 dark:text-ink-300">“{issue.evidence.note}”</p>}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <StatusChip accepted={issue.accepted} role={role} />
        <span className="text-[11px] text-ink-400">{timeAgo(issue.reported_at)}</span>
      </div>

      {canAnswer && issue.accepted === null && (
        <AnimatePresence mode="wait" initial={false}>
          {confirmDecline ? (
            <motion.div key="confirm" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 rounded-xl border border-ink-200 p-3 dark:border-ink-700">
              <p className="text-xs leading-relaxed text-ink-600 dark:text-ink-300">The customer won't be refunded for this, and your answer is final. Decline only if the order left your store complete.</p>
              <div className="mt-3 flex gap-2">
                <Button variant="ghost" className="flex-1 py-2" onClick={() => setConfirmDecline(false)}>
                  Back
                </Button>
                <Button variant="secondary" className="flex-1 py-2" loading={busy === "decline"} onClick={() => answer(false)}>
                  Decline report
                </Button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="answer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-3 flex gap-2">
              <Button variant="ghost" className="flex-1 py-2" disabled={busy !== null} onClick={() => setConfirmDecline(true)}>
                Decline
              </Button>
              <Button className="flex-1 py-2" loading={busy === "accept"} disabled={busy !== null} onClick={() => answer(true)}>
                Accept · refund {formatCents(issue.value)}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      )}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </li>
  );
}

function StatusChip({ accepted, role }: { accepted: boolean | null; role: Role }) {
  const [Icon, label, tone] =
    accepted === true
      ? [CheckCircle2, role === "store" ? "You accepted" : "Store accepted", "text-green-700 dark:text-green-300"]
      : accepted === false
        ? [XCircle, role === "store" ? "You declined" : "The store declined this", "text-ink-600 dark:text-ink-300"]
        : [Clock3, role === "store" ? "Waiting on your answer" : "Waiting on the store", "text-ink-500 dark:text-ink-400"];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${tone}`}>
      <Icon size={14} /> {label}
    </span>
  );
}

// --- reporting ---

/// Per line (by position): how many units, and what's wrong with them.
type Draft = Record<number, { quantity: number; kind: IssueKind }>;

function ReportIssueSheet({
  open,
  onClose,
  orderRef,
  items,
  alreadyReported,
  onReported,
}: {
  open: boolean;
  onClose: () => void;
  orderRef: Uint8Array;
  items: IssueItems;
  alreadyReported: IssueView[];
  onReported: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>({});
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orderTotal = items.order_total;
  const priced = items.lines.map((l) => ({ unitPrice: l.unit_price_cents, quantity: l.quantity }));
  const reported = alreadyReported.flatMap((i) => i.lines).map((l) => ({ line: l.line, quantity: l.quantity }));
  const reportedUnits = (line: number) => reported.filter((l) => l.line === line).reduce((n, l) => n + l.quantity, 0);
  const claimed = Object.entries(draft)
    .filter(([, d]) => d.quantity > 0)
    .map(([line, d]) => ({ line: Number(line), quantity: d.quantity }));
  // What this report adds to what's already reported -- the same arithmetic
  // the network uses for the refund.
  const estimate = claimedValue(priced, orderTotal, [...reported, ...claimed]) - claimedValue(priced, orderTotal, reported);

  function setUnits(line: number, quantity: number) {
    setDraft((d) => ({ ...d, [line]: { kind: d[line]?.kind ?? "Missing", quantity } }));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const lines: IssueLine[] = items.lines.flatMap((_, line) => {
        const d = draft[line];
        return d && d.quantity > 0 ? [{ line, quantity: d.quantity, kind: d.kind }] : [];
      });
      await reportIssue({ order: orderRef, lines, note: note.trim(), photo_data_uri: photo });
      setDraft({});
      setNote("");
      setPhoto("");
      await onReported();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="What went wrong?"
      subtitle="Choose the items that were missing or wrong."
      footer={
        <>
          {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          <Button className="w-full" disabled={claimed.length === 0} loading={busy} onClick={submit}>
            {claimed.length ? `Report · ${formatCents(estimate)} refund` : "Choose an item"}
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-2">
        {items.lines.map((line, position) => {
          const max = line.quantity - reportedUnits(position);
          const d = draft[position];
          const units = d?.quantity ?? 0;
          return (
            <li key={position} className={`rounded-2xl border p-3 transition ${units > 0 ? "border-relay-400 bg-relay-50/40 dark:bg-relay-900/10" : "border-ink-100 dark:border-ink-800"} ${max <= 0 ? "opacity-50" : ""}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{line.name}</p>
                  {line.choices.length > 0 && <p className="truncate text-xs text-ink-500">{line.choices.join(", ")}</p>}
                  <p className="text-xs text-ink-400">
                    {line.quantity} ordered · {formatCents(line.unit_price_cents)} each{max < line.quantity && ` · ${line.quantity - max} reported`}
                  </p>
                </div>
                <Stepper value={units} max={Math.max(0, max)} onChange={(q) => setUnits(position, q)} />
              </div>
              <AnimatePresence initial={false}>
                {units > 0 && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {(["Missing", "Wrong"] as const).map((kind) => (
                        <button
                          key={kind}
                          onClick={() => setDraft((dr) => ({ ...dr, [position]: { quantity: units, kind } }))}
                          className={`flex items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold transition ${
                            (d?.kind ?? "Missing") === kind ? "bg-ink-900 text-white dark:bg-ink-50 dark:text-ink-900" : "bg-white text-ink-600 ring-1 ring-ink-200 dark:bg-ink-900 dark:text-ink-300 dark:ring-ink-700"
                          }`}
                        >
                          {kind === "Missing" ? <AlertCircle size={13} /> : <Repeat2 size={13} />}
                          {kind === "Missing" ? "Missing" : "Wrong item"}
                        </button>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>

      <div className="mt-5">
        <p className="mb-2 text-xs font-semibold text-ink-500">Tell the store more (optional)</p>
        <Textarea value={note} maxLength={MAX_NOTE_CHARS} rows={3} placeholder="e.g. Got a chicken sandwich instead of the veggie one." onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold text-ink-500">Add a photo (optional, helps if the store disagrees)</p>
        <PhotoInput value={photo} onChange={setPhoto} shape="banner" className="w-full" />
      </div>
      <p className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-ink-400">
        <ShieldCheck size={13} className="mt-0.5 shrink-0" />
        Only the store can see your note and photo. If it accepts your report or doesn't answer, the refund is issued when your window closes.
      </p>
    </Sheet>
  );
}

function Stepper({ value, max, onChange }: { value: number; max: number; onChange: (value: number) => void }) {
  const button = "grid h-8 w-8 place-items-center rounded-full transition disabled:opacity-30";
  return (
    <div className="flex shrink-0 items-center gap-2">
      <button aria-label="Fewer" className={`${button} bg-ink-100 text-ink-700 hover:bg-ink-200 dark:bg-ink-800 dark:text-ink-200`} disabled={value === 0} onClick={() => onChange(value - 1)}>
        <Minus size={15} />
      </button>
      <span className="w-5 text-center text-sm font-bold tabular-nums text-ink-900 dark:text-ink-50">{value}</span>
      <button aria-label="More" className={`${button} bg-relay-500 text-white hover:bg-relay-600`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Plus size={15} />
      </button>
    </div>
  );
}
