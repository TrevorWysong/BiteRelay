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
import { OrderAppeal } from "./OrderAppeal";
import { t as translate, useT, type MessageKey } from "../i18n";

type Role = "customer" | "store";

const KIND_LABEL: Record<IssueKind, MessageKey> = { Missing: "issues.missing", Wrong: "issues.wrong" };

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

      {!open && <OrderAppeal orderRef={orderRef} role={role} kept={items.order_total - (decisions.refund ?? 0)} />}

      {role === "customer" && open && !settling && (
        <div className="border-t border-ink-100 p-4 dark:border-ink-800">
          <Button variant="ghost" className="w-full" onClick={() => setReporting(true)}>
            {issues.length ? translate("issues.reportMore") : translate("issues.report")}
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
  if (refund !== null) return refund > 0 ? translate("issues.refunded", { amount: formatCents(refund) }) : role === "store" ? translate("issues.noRefund") : translate("issues.declined");
  if (settling) return translate("issues.settling");
  if (role === "store") return translate("issues.storeReported", { count });
  return count ? translate("issues.reportIn") : translate("issues.ask");
}

function subline(role: Role, decisions: OrderDecisions, settling: boolean): string {
  if (decisions.refund !== null) return role === "customer" ? translate("issues.returned") : translate("issues.restYours");
  if (settling) return translate("issues.windowClosed");
  const until = decisions.reports_until !== null ? formatDeadline(decisions.reports_until) : null;
  if (role === "store") return until ? translate("issues.storeAnswerBy", { time: until }) : translate("issues.storeAnswer");
  return until ? translate("issues.reportUntil", { time: until }) : translate("issues.reportForAWhile");
}

function StorePayoutNote({ decisions, orderTotal }: { decisions: OrderDecisions; orderTotal: number }) {
  if (decisions.refund !== null || decisions.reports_until === null) return null;
  return (
    <p className="mt-4 flex items-center gap-2 rounded-2xl bg-ink-50 px-4 py-3 text-xs text-ink-600 dark:bg-ink-800/60 dark:text-ink-300">
      <Clock3 size={14} className="shrink-0 text-ink-400" />
      {translate("issues.payoutAt", { amount: formatCents(orderTotal), time: formatDeadline(decisions.reports_until) })}
    </p>
  );
}

function IssueRow({ issue, items, role, canAnswer, onAnswered }: { issue: IssueView; items: IssueItems; role: Role; canAnswer: boolean; onAnswered: () => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOf = (line: number) => {
    const ordered = items.lines[line];
    return ordered ? [ordered.name, ...ordered.choices].join(", ") : translate("issues.anItem");
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
                {t(KIND_LABEL[line.kind])}
              </span>
            </li>
          ))}
        </ul>
        <span className="shrink-0 text-sm font-bold tabular-nums text-ink-900 dark:text-ink-50">{formatCents(issue.value)}</span>
      </div>

      {issue.evidence && (issue.evidence.note || issue.evidence.photo_data_uri) && (
        <div className="mt-3 flex gap-3 rounded-xl bg-ink-50 p-3 dark:bg-ink-800/60">
          {issue.evidence.photo_data_uri && <img src={issue.evidence.photo_data_uri} alt={t("issues.customerPhoto")} className="h-16 w-16 shrink-0 rounded-lg object-cover" />}
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
              <p className="text-xs leading-relaxed text-ink-600 dark:text-ink-300">{t("issues.declineWarning")}</p>
              <div className="mt-3 flex gap-2">
                <Button variant="ghost" className="flex-1 py-2" onClick={() => setConfirmDecline(false)}>
                  {t("common.back")}
                </Button>
                <Button variant="secondary" className="flex-1 py-2" loading={busy === "decline"} onClick={() => answer(false)}>
                  {t("issues.declineReport")}
                </Button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="answer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-3 flex gap-2">
              <Button variant="ghost" className="flex-1 py-2" disabled={busy !== null} onClick={() => setConfirmDecline(true)}>
                {t("issues.decline")}
              </Button>
              <Button className="flex-1 py-2" loading={busy === "accept"} disabled={busy !== null} onClick={() => answer(true)}>
                {t("issues.acceptRefund", { amount: formatCents(issue.value) })}
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
      ? [CheckCircle2, translate(role === "store" ? "issues.youAccepted" : "issues.storeAccepted"), "text-green-700 dark:text-green-300"]
      : accepted === false
        ? [XCircle, translate(role === "store" ? "issues.youDeclined" : "issues.storeDeclined"), "text-ink-600 dark:text-ink-300"]
        : [Clock3, translate(role === "store" ? "issues.waitingYou" : "issues.waitingStore"), "text-ink-500 dark:text-ink-400"];
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
  const t = useT();
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
      title={t("issues.sheetTitle")}
      subtitle={t("issues.sheetSubtitle")}
      footer={
        <>
          {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          <Button className="w-full" disabled={claimed.length === 0} loading={busy} onClick={submit}>
            {claimed.length ? t("issues.reportButton", { amount: formatCents(estimate) }) : t("issues.chooseItem")}
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
                    {t("issues.ordered", { count: line.quantity })} · {t("cart.each", { price: formatCents(line.unit_price_cents) })}
                    {max < line.quantity && ` · ${t("issues.alreadyReported", { count: line.quantity - max })}`}
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
                          {t(KIND_LABEL[kind])}
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
        <p className="mb-2 text-xs font-semibold text-ink-500">{t("issues.tellMore")}</p>
        <Textarea value={note} maxLength={MAX_NOTE_CHARS} rows={3} placeholder={t("issues.notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold text-ink-500">{t("issues.addPhoto")}</p>
        <PhotoInput value={photo} onChange={setPhoto} shape="banner" className="w-full" />
      </div>
      <p className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-ink-400">
        <ShieldCheck size={13} className="mt-0.5 shrink-0" />
        {t("issues.privacy")}
      </p>
    </Sheet>
  );
}

function Stepper({ value, max, onChange }: { value: number; max: number; onChange: (value: number) => void }) {
  const t = useT();
  const button = "grid h-8 w-8 place-items-center rounded-full transition disabled:opacity-30";
  return (
    <div className="flex shrink-0 items-center gap-2">
      <button aria-label={t("item.fewer")} className={`${button} bg-ink-100 text-ink-700 hover:bg-ink-200 dark:bg-ink-800 dark:text-ink-200`} disabled={value === 0} onClick={() => onChange(value - 1)}>
        <Minus size={15} />
      </button>
      <span className="w-5 text-center text-sm font-bold tabular-nums text-ink-900 dark:text-ink-50">{value}</span>
      <button aria-label={t("item.more")} className={`${button} bg-relay-500 text-white hover:bg-relay-600`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Plus size={15} />
      </button>
    </div>
  );
}
