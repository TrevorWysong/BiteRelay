import { Printer, Receipt as ReceiptIcon } from "lucide-react";
import { getOrderReceipt } from "../holochain/zomes/dispatch";
import { bytesToHex } from "../holochain/decode";
import { useResource } from "../lib/hooks/useResource";
import { formatCents } from "../lib/ui/format";
import { portionLabel } from "../lib/money/ledger";
import { Button, Card, Skeleton } from "./ui";
import { appLocale, useT } from "../i18n";

/// The itemized receipt for a completed order: each item at the price it
/// was ordered at, the fees and the payments that settled it -- each
/// payment named by its transaction on the network, so it can be checked.
/// Read once: a completed order's receipt doesn't change.
export function OrderReceipt({ orderRef }: { orderRef: Uint8Array }) {
  const hex = bytesToHex(orderRef);
  const { data: receipt, error } = useResource(`receipt:${hex}`, () => getOrderReceipt(orderRef));
  const t = useT();
  if (error) return null;
  if (!receipt) return <Skeleton className="mt-4 h-40 w-full" />;
  const placed = new Date(receipt.placed_at / 1000);
  const row = (label: string, cents: number, strong = false) => (
    <div className={strong ? "flex justify-between border-t border-ink-100 dark:border-ink-800 pt-2 font-bold text-ink-900 dark:text-ink-50" : "flex justify-between"}>
      <span>{label}</span>
      <span className="tabular-nums">{formatCents(cents)}</span>
    </div>
  );
  return (
    <Card className="print-receipt mt-4 p-4 text-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
            <ReceiptIcon size={12} /> {t("receipt.title")}
          </p>
          <p className="mt-1 font-bold text-ink-900 dark:text-ink-50">{receipt.store_name}</p>
          {receipt.store_address && <p className="text-xs text-ink-400">{receipt.store_address}</p>}
          <p className="text-xs text-ink-400">
            {receipt.delivery ? t("cart.delivery") : t("cart.pickup")} · {placed.toLocaleString(appLocale(), { dateStyle: "medium", timeStyle: "short" })}
          </p>
        </div>
        <Button variant="ghost" className="no-print px-3 py-1.5 text-xs" onClick={() => window.print()}>
          <Printer size={13} /> {t("receipt.print")}
        </Button>
      </div>

      <div className="flex flex-col gap-1 text-ink-600 dark:text-ink-300">
        {receipt.lines.map((line, i) => (
          <div key={i} className="flex justify-between gap-3">
            <span>
              {line.quantity} × {line.name}
              {line.quantity > 1 && <span className="text-xs text-ink-400"> ({t("cart.each", { price: formatCents(line.unit_price_cents) })})</span>}
              {line.choices.length > 0 && <span className="block text-xs text-ink-400">{line.choices.join(", ")}</span>}
            </span>
            <span className="tabular-nums">{formatCents(line.total_cents)}</span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-col gap-1 border-t border-ink-100 dark:border-ink-800 pt-2 text-ink-600 dark:text-ink-300">
        {row(t("cart.subtotal"), receipt.subtotal_cents)}
        {receipt.discount_cents > 0 && row(t("receipt.promo"), -receipt.discount_cents)}
        {receipt.tax_cents > 0 && !receipt.tax_included && row(receipt.tax_label || t("cart.tax"), receipt.tax_cents)}
        {receipt.delivery && row(t("cart.deliveryFee"), receipt.delivery_fee_cents)}
        {receipt.tip_cents > 0 && row(t("receipt.driverTip"), receipt.tip_cents)}
        {row(t("receipt.total"), receipt.total_cents, true)}
        {receipt.tax_cents > 0 && receipt.tax_included && (
          <p className="text-right text-xs text-ink-400">
            {t("cart.includesTax", { amount: formatCents(receipt.tax_cents), tax: receipt.tax_label || t("cart.taxLower") })}
          </p>
        )}
        {receipt.tax_registration && <p className="text-xs text-ink-400">{t("receipt.taxRegistration", { number: receipt.tax_registration })}</p>}
      </div>

      {receipt.payments.length > 0 && (
        <div className="mt-3 border-t border-ink-100 dark:border-ink-800 pt-2">
          <p className="mb-1 text-xs font-semibold text-ink-500">{t("receipt.paid")}</p>
          {receipt.payments.map((payment) => (
            <div key={bytesToHex(payment.transaction)} className="flex justify-between gap-3 text-xs text-ink-500">
              <span>
                {portionLabel(payment.leg)} <span className="font-mono text-ink-300" title={bytesToHex(payment.transaction)}>· {bytesToHex(payment.transaction).slice(0, 10)}</span>
              </span>
              <span className="tabular-nums">{formatCents(payment.amount_cents)}</span>
            </div>
          ))}
          <p className="mt-1 text-[11px] text-ink-400">{t("receipt.verifiable")}</p>
        </div>
      )}
    </Card>
  );
}
