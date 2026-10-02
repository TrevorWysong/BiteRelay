import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ClipboardList, RotateCcw, PlayCircle } from "lucide-react";
import { getOrdersForRequester, openScheduledOrder } from "../../holochain/zomes/dispatch";
import { getCatalog, listMenuItems } from "../../holochain/zomes/catalog";
import { decodeEntry, actionHash, bytesEqual, bytesToHex } from "../../holochain/decode";
import { myAgentPubKey } from "../../holochain/client";
import { useCart } from "../../store/cart";
import { Button, EmptyState, Spinner } from "../../components/ui";
import { StatusBadge } from "../../components/OrderStatus";
import { formatCents } from "../../lib/format";
import type { DeliveryOrder, MenuItem, MerchantCatalog } from "../../holochain/types";

interface Row {
  hash: Uint8Array;
  order: DeliveryOrder;
}

export function Orders() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [reordering, setReordering] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const cart = useCart();
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      const records = await getOrdersForRequester(myAgentPubKey());
      const decoded = records.map((r) => ({ hash: actionHash(r), order: decodeEntry<DeliveryOrder>(r) }));
      decoded.sort((a, b) => b.order.requested_at - a.order.requested_at);
      setRows(decoded);
    } catch {
      setRows([]);
    }
  }, []);

  async function openNow(hash: Uint8Array) {
    setOpening(bytesToHex(hash));
    try {
      await openScheduledOrder(hash);
      await refresh();
    } catch {
      // Most likely "too early" -- validate()'s own deterministic check is
      // the real enforcement, this is just a client-side convenience, so a
      // failed attempt here isn't worth a dedicated error banner.
    } finally {
      setOpening(null);
    }
  }

  // Reconstructs the cart from a past order's item_refs (repeated per
  // quantity, see Cart.tsx's requestDelivery call) against the merchant's
  // *current* menu -- an item since removed or repriced just gets dropped
  // or re-priced in the reordered cart, best-effort, rather than failing
  // the whole reorder over one stale reference.
  async function reorder(order: DeliveryOrder) {
    setReordering(bytesToHex(order.catalog_ref));
    try {
      const catalogRecord = await getCatalog(order.catalog_ref);
      const catalog = decodeEntry<MerchantCatalog>(catalogRecord);
      const page = await listMenuItems(order.catalog_ref);
      const menuItems = page.items.map((r) => ({ hash: actionHash(r), item: decodeEntry<MenuItem>(r) }));

      const counts = new Map<string, { itemRef: Uint8Array; quantity: number }>();
      for (const ref of order.item_refs) {
        const key = bytesToHex(ref);
        const existing = counts.get(key);
        if (existing) existing.quantity += 1;
        else counts.set(key, { itemRef: ref, quantity: 1 });
      }

      const lines = Array.from(counts.values())
        .map(({ itemRef, quantity }) => {
          const menuItem = menuItems.find((m) => bytesEqual(m.hash, itemRef));
          return menuItem ? { itemRef, name: menuItem.item.name, priceCents: menuItem.item.price_cents, quantity } : null;
        })
        .filter((l): l is NonNullable<typeof l> => l !== null);

      cart.setCart(order.catalog_ref, order.merchant, catalog.business_name, lines);
      navigate("/customer/cart");
    } finally {
      setReordering(null);
    }
  }

  useEffect(() => {
    refresh();
  }, [refresh]);

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
          <div key={bytesToHex(hash)} className="flex items-center gap-2 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4">
            <Link to={`/customer/orders/${bytesToHex(hash)}`} className="min-w-0 flex-1">
              <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{formatCents(order.order_total)}</p>
              <p className="text-xs text-ink-400">{order.item_refs.length} item{order.item_refs.length === 1 ? "" : "s"}</p>
            </Link>
            <StatusBadge status={order.status} />
            {order.status === "Scheduled" && order.requested_delivery_time !== null && order.requested_delivery_time <= Date.now() * 1000 && (
              <Button variant="primary" className="px-2.5 py-1.5 text-xs" loading={opening === bytesToHex(hash)} onClick={() => openNow(hash)}>
                <PlayCircle size={13} />
              </Button>
            )}
            <Button
              variant="ghost"
              className="px-2.5 py-1.5 text-xs"
              loading={reordering === bytesToHex(order.catalog_ref)}
              onClick={() => reorder(order)}
            >
              <RotateCcw size={13} />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
