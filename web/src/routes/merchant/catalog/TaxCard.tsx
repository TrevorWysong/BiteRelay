// The store's sales tax or VAT. The store is the seller of record: it
// charges and remits its own tax, as on its counter and phone orders
// (docs/SALES_TAX.md). Each rate is named for what it applies to; the first is
// the default, and menu items pick another. Orders placed from here on are
// taxed at these rates -- and the network checks every one against them.
import { useState } from "react";
import { Download, Plus, Trash2 } from "lucide-react";
import type { MerchantCatalog, TaxRate } from "../../../holochain/types";
import { MAX_LABEL_CHARS } from "../../../holochain/types";
import { setTaxSettings } from "../../../holochain/zomes/catalog";
import { Button, Card, Checkbox, Input, Skeleton } from "../../../components/ui";
import { bytesToHex } from "../../../holochain/decode";
import { formatCents, fromMinorUnits } from "../../../lib/ui/format";
import { storeTaxReport, taxReportCsv } from "../../../lib/money/taxReport";
import { useResource } from "../../../lib/hooks/useResource";
import { describeError } from "../../../lib/ui/errors";
import { percentLabel } from "../../../lib/menu/tax";
import { useT, type MessageKey } from "../../../i18n";

/// The network's own bounds (`catalog_types::MAX_TAX_RATES`, `MAX_TAX_BASIS_POINTS`).
const MAX_RATES = 8;
const MAX_PERCENT = 50;

interface DraftRate {
  name: string;
  percent: string;
}

export function TaxCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const t = useT();
  const saved = catalog.tax_rates ?? [];
  const [rates, setRates] = useState<DraftRate[]>(() => saved.map((r) => ({ name: r.category, percent: String(r.basis_points / 100) })));
  const [included, setIncluded] = useState(catalog.prices_include_tax ?? false);
  const [registration, setRegistration] = useState(catalog.tax_registration ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed: TaxRate[] = rates.map((r) => ({ category: r.name.trim(), label: r.name.trim(), basis_points: Math.round(Number(r.percent) * 100) }));
  const problem =
    parsed.some((r) => !r.category) ? t("taxEditor.problem.name") :
    parsed.some((r) => !Number.isFinite(r.basis_points) || r.basis_points < 0 || r.basis_points > MAX_PERCENT * 100) ? t("taxEditor.problem.range", { max: MAX_PERCENT }) :
    new Set(parsed.map((r) => r.category)).size !== parsed.length ? t("taxEditor.problem.unique") :
    null;

  async function save() {
    if (problem) return;
    setSaving(true);
    setError(null);
    try {
      await setTaxSettings(catalogRef, { tax_rates: parsed, prices_include_tax: included, tax_registration: registration });
      await onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  const set = (i: number, patch: Partial<DraftRate>) => setRates((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Card className="mb-4 p-4">
      <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-400">{t("cart.tax")}</p>
      <p className="mb-3 text-xs leading-relaxed text-ink-400">
        {saved.length === 0
          ? t("taxEditor.intro")
          : t(catalog.prices_include_tax ? "taxEditor.chargingIncluded" : "taxEditor.chargingAdded", { rates: saved.map((r) => `${r.category} ${percentLabel(r.basis_points)}`).join(", ") })}
      </p>
      <div className="flex flex-col gap-2">
        {rates.map((rate, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input maxLength={MAX_LABEL_CHARS} value={rate.name} onChange={(e) => set(i, { name: e.target.value })} placeholder={i === 0 ? t("taxEditor.firstPlaceholder") : t("taxEditor.otherPlaceholder")} aria-label={t("taxEditor.rateName")} />
            <Input type="number" inputMode="decimal" min={0} max={MAX_PERCENT} step={0.05} value={rate.percent} onChange={(e) => set(i, { percent: e.target.value })} suffix="%" className="w-24" aria-label={t("taxEditor.rate")} />
            <button type="button" aria-label={t("taxEditor.remove")} onClick={() => setRates((prev) => prev.filter((_, j) => j !== i))} className="text-ink-300 hover:text-red-500">
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        {rates.length < MAX_RATES && (
          <Button variant="ghost" className="py-2 text-xs" onClick={() => setRates((prev) => [...prev, { name: "", percent: "" }])}>
            <Plus size={14} /> {rates.length === 0 ? t("taxEditor.add") : t("taxEditor.addAnother")}
          </Button>
        )}
      </div>
      {rates.length > 0 && (
        <>
          <label className="mt-3 flex items-start gap-2 text-sm text-ink-600 dark:text-ink-300">
            <Checkbox checked={included} onChange={(e) => setIncluded(e.target.checked)} className="mt-0.5" />
            {t("taxEditor.included")}
          </label>
          <Input className="mt-3" maxLength={MAX_LABEL_CHARS} value={registration} onChange={(e) => setRegistration(e.target.value)} placeholder={t("taxEditor.registration")} />
        </>
      )}
      {(problem || error) && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error ?? problem}</p>}
      <Button className="mt-3 w-full py-2 text-xs" loading={saving} disabled={!!problem} onClick={save}>
        {t("taxEditor.save")}
      </Button>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-400">{t("taxEditor.advice")}</p>
    </Card>
  );
}

type Period = "this-month" | "last-month" | "this-quarter" | "this-year" | "last-year";

const PERIODS: { value: Period; label: MessageKey }[] = [
  { value: "this-month", label: "taxReport.thisMonth" },
  { value: "last-month", label: "taxReport.lastMonth" },
  { value: "this-quarter", label: "taxReport.thisQuarter" },
  { value: "this-year", label: "taxReport.thisYear" },
  { value: "last-year", label: "taxReport.lastYear" },
];

/// A period's [start, end), in local time.
function periodRange(period: Period, now = new Date()): [Date, Date] {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (period) {
    case "this-month":
      return [new Date(y, m, 1), new Date(y, m + 1, 1)];
    case "last-month":
      return [new Date(y, m - 1, 1), new Date(y, m, 1)];
    case "this-quarter": {
      const q = Math.floor(m / 3) * 3;
      return [new Date(y, q, 1), new Date(y, q + 3, 1)];
    }
    case "this-year":
      return [new Date(y, 0, 1), new Date(y + 1, 0, 1)];
    case "last-year":
      return [new Date(y - 1, 0, 1), new Date(y, 0, 1)];
  }
}

/// What the store sold in a period and the tax it collected, from its own
/// order history -- read on this device, when asked.
export function TaxReportCard({ catalogRef }: { catalogRef: Uint8Array }) {
  const t = useT();
  const [period, setPeriod] = useState<Period | null>(null);
  const range = period ? periodRange(period) : null;
  const { data: report, error } = useResource(period ? `tax-report:${bytesToHex(catalogRef)}:${period}` : null, () => storeTaxReport(catalogRef, range![0], range![1]));
  const minor = (cents: number) => fromMinorUnits(cents).toFixed(2);

  function download() {
    if (!report || !period) return;
    const url = URL.createObjectURL(new Blob([taxReportCsv(report, minor)], { type: "text/csv" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: `tax-report-${period}.csv` });
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card className="mb-4 p-4">
      <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-400">{t("taxReport.title")}</p>
      <p className="mb-3 text-xs leading-relaxed text-ink-400">{t("taxReport.detail")}</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PERIODS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => setPeriod(p.value)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${period === p.value ? "bg-handshake-500 text-white" : "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300"}`}
          >
            {t(p.label)}
          </button>
        ))}
      </div>
      {period &&
        (report ? (
          <>
            <dl className="grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-ink-500">{t("nav.orders")}</dt>
              <dd className="text-right tabular-nums">{report.orders.length}</dd>
              <dt className="text-ink-500">{t("taxReport.sales")}</dt>
              <dd className="text-right tabular-nums">{formatCents(report.salesCents)}</dd>
              <dt className="text-ink-500">{t("taxReport.collected")}</dt>
              <dd className="text-right tabular-nums">{formatCents(report.taxCents)}</dd>
              <dt className="text-ink-500">{t("taxReport.refunded")}</dt>
              <dd className="text-right tabular-nums">-{formatCents(report.refundedTaxCents)}</dd>
              <dt className="font-semibold text-ink-900 dark:text-ink-50">{t("taxReport.remit")}</dt>
              <dd className="text-right font-semibold tabular-nums text-ink-900 dark:text-ink-50">{formatCents(report.netTaxCents)}</dd>
            </dl>
            {report.orders.length > 0 && (
              <Button variant="ghost" className="mt-3 w-full py-2 text-xs" onClick={download}>
                <Download size={14} /> {t("earnings.csv")}
              </Button>
            )}
          </>
        ) : error ? (
          <p className="text-xs text-red-600 dark:text-red-400">{describeError(error)}</p>
        ) : (
          <Skeleton className="h-24 w-full" />
        ))}
    </Card>
  );
}
