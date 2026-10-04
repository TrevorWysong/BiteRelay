import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ClipboardList, Pause, Play, Repeat, RotateCcw, PlayCircle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { getOrdersForRequester, openScheduledOrder, listMyRecurringTemplates, setRecurringTemplateActive } from "../../holochain/zomes/dispatch";
import { getCatalog, listMenuItems } from "../../holochain/zomes/catalog";
import { decodeEntry, actionHash, bytesEqual, bytesToHex } from "../../holochain/decode";
import { onLocalSignal, myAgentPubKey } from "../../holochain/client";
import { useCart } from "../../store/cart";
import { Button, Card, EmptyState, Skeleton, StatNumber } from "../../components/ui";
import { StatusBadge } from "../../components/OrderStatus";
import { formatCents } from "../../lib/format";
import { describeRecurrence } from "../../lib/recurrence";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import type { DeliveryOrder, MenuItem, MerchantCatalog, RecurringOrderTemplate } from "../../holochain/types";

interface Row {
  hash: Uint8Array;
  order: DeliveryOrder;
}

interface RecurringRow {
  hash: Uint8Array;
  template: RecurringOrderTemplate;
  merchantName: string;
}

// Matches merchant/Orders.tsx, driver/Dashboard.tsx, and
// arbitrator/Dashboard.tsx's identical cadence -- this was previously the
// one "my list of X" screen with no refresh after its initial load, so a
// status change (a bid accepted, a dispute resolved) wouldn't show up
// without manually leaving and returning to the screen.
const POLL_MS = 8000;

export function Orders() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [reordering, setReordering] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [recurring, setRecurring] = useState<RecurringRow[]>([]);
  const [togglingRecurring, setTogglingRecurring] = useState<string | null>(null);
  const cart = useCart();
  const navigate = useNavigate();

  const refreshRecurring = useCallback(async () => {
    try {
      const records = await listMyRecurringTemplates();
      const decoded = await Promise.all(
        records.map(async (r) => {
          const template = decodeEntry<RecurringOrderTemplate>(r);
          const merchantName = await getCatalog(template.catalog_ref)
            .then((cr) => decodeEntry<MerchantCatalog>(cr).business_name)
            .catch(() => "Restaurant");
          return { hash: actionHash(r), template, merchantName };
        }),
      );
      setRecurring(decoded);
    } catch {
      setRecurring([]);
    }
  }, []);

  async function toggleRecurring(row: RecurringRow) {
    setTogglingRecurring(bytesToHex(row.hash));
    try {
      await setRecurringTemplateActive(row.hash, !row.template.active);
      await refreshRecurring();
    } finally {
      setTogglingRecurring(null);
    }
  }

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
    refreshRecurring();
    const interval = setInterval(refresh, POLL_MS);
    const unsub = onLocalSignal(() => refresh());
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [refresh, refreshRecurring]);

  if (rows === null) {
    return (
      <div className="px-4 pt-4">
        <Skeleton className="h-7 w-1/3 mb-4" />
        <Skeleton className="h-16 w-full mb-3" />
        <Skeleton className="h-16 w-full mb-3" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4">
      <motion.h1 variants={fadeSlideUp} className="mb-4 text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">
        Your orders
      </motion.h1>

      {recurring.length > 0 && (
        <motion.div variants={fadeSlideUp} className="mb-5">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
            <Repeat size={13} /> Recurring orders
          </p>
          <div className="flex flex-col gap-2">
            {recurring.map((row) => (
              <Card key={bytesToHex(row.hash)} className="flex items-center justify-between p-3.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{row.merchantName}</p>
                  <p className="text-xs text-ink-400">{describeRecurrence(row.template.recurrence)}</p>
                </div>
                <Button
                  variant={row.template.active ? "secondary" : "ghost"}
                  className="px-3 py-1.5 text-xs"
                  loading={togglingRecurring === bytesToHex(row.hash)}
                  onClick={() => toggleRecurring(row)}
                >
                  {row.template.active ? <Pause size={13} /> : <Play size={13} />} {row.template.active ? "Active" : "Paused"}
                </Button>
              </Card>
            ))}
          </div>
        </motion.div>
      )}

      {rows.length === 0 && (
        <motion.div variants={fadeSlideUp}>
          <EmptyState icon={<ClipboardList size={32} />} title="No orders yet" subtitle="Place one from Browse to see it show up here automatically." />
        </motion.div>
      )}

      <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="flex flex-col gap-3 pb-6">
        <AnimatePresence initial={false}>
          {rows.map(({ hash, order }) => (
            <motion.div key={bytesToHex(hash)} layout variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0 }}>
              <Card className="flex items-center gap-2 p-4">
                <Link to={`/customer/orders/${bytesToHex(hash)}`} className="min-w-0 flex-1">
                  <StatNumber className="text-sm">{formatCents(order.order_total)}</StatNumber>
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
              </Card>
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
