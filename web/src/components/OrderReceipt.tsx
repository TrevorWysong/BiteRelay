import { Printer, Receipt as ReceiptIcon } from "lucide-react";
import { getOrderReceipt } from "../holochain/zomes/dispatch";
import { bytesToHex } from "../holochain/decode";
import { useResource } from "../lib/useResource";
import { formatCents } from "../lib/format";
import { PORTION_LABEL } from "../lib/ledger";
import { Button, Card, Skeleton } from "./ui";

/// The itemized receipt for a completed order: each item at the price it
/// was ordered at, the fees and the payments that settled it -- each
/// payment named by its transaction on the network, so it can be checked.
/// Read once: a completed order's receipt doesn't change.
export function OrderReceipt({ orderRef }: { orderRef: Uint8Array }) {
  const hex = bytesToHex(orderRef);
  const { data: receipt, error } = useResource(`receipt:${hex}`, () => getOrderReceipt(orderRef));
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
            <ReceiptIcon size={12} /> Receipt
          </p>
          <p className="mt-1 font-bold text-ink-900 dark:text-ink-50">{receipt.store_name}</p>
          {receipt.store_address && <p className="text-xs text-ink-400">{receipt.store_address}</p>}
          <p className="text-xs text-ink-400">
            {receipt.delivery ? "Delivery" : "Pickup"} · {placed.toLocaleDateString([], { dateStyle: "medium" })}, {placed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </p>
        </div>
        <Button variant="ghost" className="no-print px-3 py-1.5 text-xs" onClick={() => window.print()}>
          <Printer size={13} /> Print
        </Button>
      </div>

      <div className="flex flex-col gap-1 text-ink-600 dark:text-ink-300">
        {receipt.lines.map((line, i) => (
          <div key={i} className="flex justify-between gap-3">
            <span>
              {line.quantity} × {line.name}
              {line.quantity > 1 && <span className="text-xs text-ink-400"> ({formatCents(line.unit_price_cents)} each)</span>}
            </span>
            <span className="tabular-nums">{formatCents(line.total_cents)}</span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-col gap-1 border-t border-ink-100 dark:border-ink-800 pt-2 text-ink-600 dark:text-ink-300">
        {row("Subtotal", receipt.subtotal_cents)}
        {receipt.discount_cents > 0 && row("Promo", -receipt.discount_cents)}
        {receipt.delivery && row("Delivery fee", receipt.delivery_fee_cents)}
        {receipt.tip_cents > 0 && row("Driver tip", receipt.tip_cents)}
        {row("Total", receipt.total_cents, true)}
      </div>

      {receipt.payments.length > 0 && (
        <div className="mt-3 border-t border-ink-100 dark:border-ink-800 pt-2">
          <p className="mb-1 text-xs font-semibold text-ink-500">Paid</p>
          {receipt.payments.map((payment) => (
            <div key={bytesToHex(payment.transaction)} className="flex justify-between gap-3 text-xs text-ink-500">
              <span>
                {PORTION_LABEL[payment.leg]} <span className="font-mono text-ink-300" title={bytesToHex(payment.transaction)}>· {bytesToHex(payment.transaction).slice(0, 10)}</span>
              </span>
              <span className="tabular-nums">{formatCents(payment.amount_cents)}</span>
            </div>
          ))}
          <p className="mt-1 text-[11px] text-ink-400">Each payment is a transaction on the network, signed by you. Anyone holding it can check it.</p>
        </div>
      )}
    </Card>
  );
}
