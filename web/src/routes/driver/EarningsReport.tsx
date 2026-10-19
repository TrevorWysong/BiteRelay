// A driver's earnings by week or month -- deliveries, fees, tips, what
// stores paid for keeping them waiting, collateral forfeited, cash-outs --
// read from their own ledger on this device, with a CSV for their records.
import { useState } from "react";
import { Download } from "lucide-react";
import { listMyLedger } from "../../holochain/zomes/ledger";
import { actionHash, decodeEntry, timestampOf } from "../../holochain/decode";
import type { LedgerEntry } from "../../holochain/types";
import { Card, Skeleton } from "../../components/ui";
import { earned, earningsByPeriod, earningsCsv, type Grouping, type LedgerRow } from "../../lib/earnings";
import { formatCents, fromMinorUnits } from "../../lib/format";
import { appLocale } from "../../i18n";
import { useResource } from "../../lib/useResource";

/// Every entry on the caller's ledger, page by page.
async function wholeLedger(): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  let before: number | null = null;
  for (;;) {
    const page = await listMyLedger(before);
    rows.push(...page.entries.map((r) => ({ hash: actionHash(r), entry: decodeEntry<LedgerEntry>(r), at: timestampOf(r) })));
    if (page.next_before === null || page.next_before === undefined) return rows;
    before = page.next_before;
  }
}

export function EarningsReport({ meHex }: { meHex: string }) {
  const [grouping, setGrouping] = useState<Grouping>("week");
  const { data: rows } = useResource(`whole-ledger:${meHex}`, wholeLedger);
  const periods = rows ? earningsByPeriod(rows, grouping).filter((p) => earned(p) + p.forfeited + p.cashedOut > 0) : undefined;
  const label = (start: number) =>
    grouping === "week"
      ? `Week of ${new Date(start).toLocaleDateString(appLocale(), { day: "numeric", month: "short" })}`
      : new Date(start).toLocaleDateString(appLocale(), { month: "long", year: "numeric" });

  function download() {
    if (!periods) return;
    const url = URL.createObjectURL(new Blob([earningsCsv(periods, grouping, (c) => fromMinorUnits(c).toFixed(2))], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: `relay-earnings-by-${grouping}.csv` }).click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card className="mb-4 p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-bold text-ink-900 dark:text-ink-50">Earnings</p>
        <div className="flex items-center gap-1 rounded-full bg-ink-100 p-1 text-xs font-semibold dark:bg-ink-800">
          {(["week", "month"] as const).map((g) => (
            <button key={g} onClick={() => setGrouping(g)} className={`rounded-full px-2.5 py-1 ${grouping === g ? "bg-white shadow-sm dark:bg-ink-950" : "text-ink-400"}`}>
              {g === "week" ? "Weekly" : "Monthly"}
            </button>
          ))}
        </div>
      </div>
      {periods === undefined ? (
        <Skeleton className="h-24" />
      ) : periods.length === 0 ? (
        <p className="text-sm text-ink-400">Your deliveries' fees and tips appear here once they settle.</p>
      ) : (
        <>
          <ul className="divide-y divide-ink-100 dark:divide-ink-800">
            {periods.slice(0, 12).map((p) => (
              <li key={p.start} className="py-2.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold text-ink-800 dark:text-ink-100">{label(p.start)}</span>
                  <span className="text-sm font-black text-ink-900 dark:text-ink-50">{formatCents(earned(p))}</span>
                </div>
                <p className="text-xs text-ink-400">
                  {p.deliveries} {p.deliveries === 1 ? "delivery" : "deliveries"} · fees {formatCents(p.fees)} · tips {formatCents(p.tips)}
                  {p.lateCover > 0 && ` · waiting ${formatCents(p.lateCover)}`}
                  {p.forfeited > 0 && ` · forfeited ${formatCents(p.forfeited)}`}
                  {p.cashedOut > 0 && ` · cashed out ${formatCents(p.cashedOut)}`}
                </p>
              </li>
            ))}
          </ul>
          <button onClick={download} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-relay-600 dark:text-relay-400">
            <Download size={13} /> Download as CSV
          </button>
        </>
      )}
    </Card>
  );
}
