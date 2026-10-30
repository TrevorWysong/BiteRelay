// What an order is -- each line's quantity, item and choices ("Large, Oat
// milk, 2 x Extra shot") -- for the kitchen making it and the customer
// checking it. An order's lines never change, so they're read once.
import { getOrderLines } from "../holochain/zomes/dispatch";
import { bytesToHex } from "../holochain/decode";
import { formatCents } from "../lib/ui/format";
import { useResource } from "../lib/hooks/useResource";
import { Card, Skeleton } from "./ui";
import { useT } from "../i18n";

export function OrderLines({ orderRef, prices = false, className = "" }: { orderRef: Uint8Array; prices?: boolean; className?: string }) {
  const { data: lines } = useResource(`order-lines:${bytesToHex(orderRef)}`, () => getOrderLines(orderRef));
  if (!lines) return <Skeleton className={`h-10 w-full ${className}`} />;
  return (
    <ul className={`flex flex-col gap-1.5 ${className}`}>
      {lines.map((line, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <span className="w-6 shrink-0 font-bold tabular-nums text-ink-900 dark:text-ink-50">{line.quantity}×</span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-ink-800 dark:text-ink-100">{line.name}</p>
            {line.choices.length > 0 && (
              <ul className="mt-0.5 flex flex-col text-xs text-ink-500 dark:text-ink-400">
                {line.choices.map((choice, j) => (
                  <li key={j}>{choice}</li>
                ))}
              </ul>
            )}
          </div>
          {prices && <span className="shrink-0 tabular-nums text-ink-600 dark:text-ink-300">{formatCents(line.unit_price_cents * line.quantity)}</span>}
        </li>
      ))}
    </ul>
  );
}

/// The order's lines in a card that opens on tap -- "Your order (3 items)".
export function OrderSummary({ orderRef, count }: { orderRef: Uint8Array; count: number }) {
  const t = useT();
  return (
    <Card className="mt-4 p-4">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-ink-900 dark:text-ink-50">
          {t("lines.summary", { count })}
          <span className="text-xs font-normal text-ink-400 group-open:hidden">{t("common.show")}</span>
          <span className="hidden text-xs font-normal text-ink-400 group-open:inline">{t("common.hide")}</span>
        </summary>
        <OrderLines orderRef={orderRef} prices className="mt-3" />
      </details>
    </Card>
  );
}
