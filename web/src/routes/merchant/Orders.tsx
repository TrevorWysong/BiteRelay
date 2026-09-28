import { useCallback, useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import { getOrdersForMerchant, setOrderStatus } from "../../holochain/zomes/dispatch";
import { decodeEntry, actionHash, bytesToHex } from "../../holochain/decode";
import { onLocalSignal, myAgentPubKey } from "../../holochain/client";
import { Button, Card, EmptyState, Spinner } from "../../components/ui";
import { StatusBadge } from "../../components/OrderStatus";
import { formatCents } from "../../lib/format";
import type { DeliveryOrder } from "../../holochain/types";

interface Row {
  hash: Uint8Array;
  order: DeliveryOrder;
}

const POLL_MS = 8000;

export function MerchantOrders() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const records = await getOrdersForMerchant(myAgentPubKey());
    const decoded = records.map((r) => ({ hash: actionHash(r), order: decodeEntry<DeliveryOrder>(r) }));
    decoded.sort((a, b) => b.order.requested_at - a.order.requested_at);
    setRows(decoded);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    const unsub = onLocalSignal(() => refresh());
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [refresh]);

  async function confirmPrep(hash: Uint8Array) {
    setConfirming(bytesToHex(hash));
    try {
      await setOrderStatus(hash, "MerchantConfirmed");
      await refresh();
    } finally {
      setConfirming(null);
    }
  }

  if (rows === null) {
    return (
      <div className="flex justify-center py-16 text-ink-300">
        <Spinner />
      </div>
    );
  }

  if (rows.length === 0) {
    return <EmptyState icon={<ClipboardList size={32} />} title="No orders yet" subtitle="Orders naming your catalog show up here automatically -- this reads your own MerchantToOrder links." />;
  }

  return (
    <div className="px-4 pt-4 pb-8">
      <h1 className="mb-4 text-xl font-black text-ink-900 dark:text-ink-50">Incoming orders</h1>
      <div className="flex flex-col gap-3">
        {rows.map(({ hash, order }) => (
          <Card key={bytesToHex(hash)} className="p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{formatCents(order.order_total)}</p>
              <StatusBadge status={order.status} />
            </div>
            <p className="mt-1 text-xs text-ink-400">{order.item_refs.length} item{order.item_refs.length === 1 ? "" : "s"}</p>
            {order.special_instructions && <p className="mt-1 text-xs italic text-ink-500">"{order.special_instructions}"</p>}
            {order.status === "BidAccepted" && (
              <Button className="mt-3 w-full py-2 text-xs" loading={confirming === bytesToHex(hash)} onClick={() => confirmPrep(hash)}>
                Confirm prep started
              </Button>
            )}
            {order.status === "Open" && <p className="mt-2 text-xs text-ink-400">Waiting for a driver to be assigned.</p>}
            {(order.status === "MerchantConfirmed" || order.status === "DriverEnRouteToMerchant") && (
              <p className="mt-2 text-xs text-ink-400">Driver is on the way to pick this up — stay connected so they can confirm the handoff with you directly.</p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
