// How the store's been doing over the last week or month, from its own
// order history, read on this device when asked.
import { useState } from "react";
import { TrendingUp } from "lucide-react";
import { bytesToHex } from "../../../holochain/decode";
import { Card, Skeleton, StatNumber } from "../../../components/ui";
import { storeInsights, storeOrdersSince } from "../../../lib/insights";
import type { ItemRow } from "../../../lib/menu";
import { formatCents } from "../../../lib/format";
import { useResource } from "../../../lib/useResource";
import { useT } from "../../../i18n";

const PERIODS = [7, 30] as const;

export function InsightsCard({ catalogRef, items }: { catalogRef: Uint8Array; items: ItemRow[] }) {
  const [days, setDays] = useState<(typeof PERIODS)[number] | null>(null);
  const t = useT();
  const { data: orders, error } = useResource(days ? `insights:${bytesToHex(catalogRef)}:${days}` : null, () => storeOrdersSince(catalogRef, new Date(Date.now() - days! * 86_400_000)));
  const insights = orders ? storeInsights(orders) : null;
  const nameOf = (hex: string) => items.find((row) => bytesToHex(row.hash) === hex)?.item.name ?? t("insights.removed");
  const busiest = insights ? Math.max(...insights.byHour) : 0;

  return (
    <Card className="mb-4 p-4">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
        <TrendingUp size={13} /> {t("insights.title")}
      </p>
      <div className="mb-3 flex gap-1.5">
        {PERIODS.map((p) => (
          <button key={p} type="button" onClick={() => setDays(p)} className={`rounded-full px-3 py-1 text-xs font-semibold ${days === p ? "bg-relay-500 text-white" : "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300"}`}>
            {t("insights.lastDays", { count: p })}
          </button>
        ))}
      </div>
      {days === null ? (
        <p className="text-xs text-ink-400">{t("insights.intro")}</p>
      ) : error ? (
        <p className="text-xs text-red-600">{t("insights.error")}</p>
      ) : !insights ? (
        <Skeleton className="h-28" />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <StatNumber className="text-lg">{formatCents(insights.netSalesCents)}</StatNumber>
              <p className="text-[11px] text-ink-400">{t("insights.sales")}</p>
            </div>
            <div>
              <StatNumber className="text-lg">{insights.completed}</StatNumber>
              <p className="text-[11px] text-ink-400">{t("insights.orders", { average: formatCents(insights.averageOrderCents) })}</p>
            </div>
            <div>
              <StatNumber className="text-lg" tone={insights.cancelled > 0 ? "danger" : "default"}>
                {insights.cancelled}
              </StatNumber>
              <p className="text-[11px] text-ink-400">{t("insights.cancelled")}</p>
            </div>
          </div>
          {insights.topItems.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-500">{t("insights.best")}</p>
              <ol className="flex flex-col gap-0.5 text-sm">
                {insights.topItems.map((top) => (
                  <li key={top.item} className="flex justify-between">
                    <span className="truncate">{nameOf(top.item)}</span>
                    <span className="text-ink-400">{t("insights.sold", { count: top.quantity })}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {busiest > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-500">{t("insights.byHour")}</p>
              <div className="flex h-16 items-end gap-px" aria-label={t("insights.byHourLabel")}>
                {insights.byHour.map((n, hour) => (
                  <div key={hour} title={`${hour}:00 · ${n}`} className="flex-1 rounded-t bg-relay-400" style={{ height: `${Math.max(2, (n / busiest) * 100)}%`, opacity: n ? 1 : 0.2 }} />
                ))}
              </div>
              <div className="mt-0.5 flex justify-between text-[10px] text-ink-400">
                <span>0:00</span>
                <span>12:00</span>
                <span>23:00</span>
              </div>
            </div>
          )}
          <p className="text-xs text-ink-400">{t("insights.deliveredShare", { percent: Math.round(insights.deliveryShare * 100) })}</p>
        </div>
      )}
    </Card>
  );
}
