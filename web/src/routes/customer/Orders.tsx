import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardList } from "lucide-react";
import { getOrdersForRequester } from "../../holochain/zomes/dispatch";
import { decodeEntry, actionHash, bytesToHex } from "../../holochain/decode";
import { myAgentPubKey } from "../../holochain/client";
import { EmptyState, Spinner } from "../../components/ui";
import { StatusBadge } from "../../components/OrderStatus";
import { formatCents } from "../../lib/format";
import type { DeliveryOrder } from "../../holochain/types";

interface Row {
  hash: Uint8Array;
  order: DeliveryOrder;
}

export function Orders() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getOrdersForRequester(myAgentPubKey())
      .then((records) => {
        if (cancelled) return;
        const decoded = records.map((r) => ({ hash: actionHash(r), order: decodeEntry<DeliveryOrder>(r) }));
        decoded.sort((a, b) => b.order.requested_at - a.order.requested_at);
        setRows(decoded);
      })
      .catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, []);

  if (rows === null) {
    return (
      <div className="flex justify-center py-16 text-ink-300">
        <Spinner />
      </div>
    );
  }

  if (rows.length === 0) {
    return <EmptyState icon={<ClipboardList size={32} />} title="No orders yet" subtitle="Place one from Browse to see it show up here — this reads your own RequesterToOrder links directly off the DHT." />;
  }

  return (
    <div className="px-4 pt-4">
      <h1 className="mb-4 text-xl font-black text-ink-900 dark:text-ink-50">Your orders</h1>
      <div className="flex flex-col gap-3 pb-6">
        {rows.map(({ hash, order }) => (
          <Link
            key={bytesToHex(hash)}
            to={`/customer/orders/${bytesToHex(hash)}`}
            className="flex items-center justify-between rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4"
          >
            <div>
              <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{formatCents(order.order_total)}</p>
              <p className="text-xs text-ink-400">{order.item_refs.length} item{order.item_refs.length === 1 ? "" : "s"}</p>
            </div>
            <StatusBadge status={order.status} />
          </Link>
        ))}
      </div>
    </div>
  );
}
