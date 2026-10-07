import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ClipboardList, Store } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { getOrdersForStore, getPickupOrdersForStore, setOrderStatus, confirmPickupPrep, markReadyForPickup } from "../../holochain/zomes/dispatch";
import { decodeEntry, actionHash, bytesToHex } from "../../holochain/decode";
import { useMyStores, type StoreRow } from "../../store/merchantStores";
import { useResource } from "../../lib/useResource";
import { Button, Card, Chip, ChipRow, EmptyState, Skeleton, StatNumber } from "../../components/ui";
import { StatusBadge, PickupStatusBadge } from "../../components/OrderStatus";
import { formatCents } from "../../lib/format";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import type { DeliveryOrder, PickupOrder } from "../../holochain/types";

interface Row {
  hash: Uint8Array;
  order: DeliveryOrder;
  storeHex: string;
}

interface PickupRow {
  hash: Uint8Array;
  order: PickupOrder;
  storeHex: string;
}

const POLL_MS = 8000;

/// "All stores" isn't a store hex, so it can't collide with one.
const ALL_STORES = "all";

/// Incoming orders across every store this merchant runs -- each store has
/// its own queue on the DHT (`StoreToOrder`/`StoreToPickupOrder`), and this
/// screen reads either one store's or all of them, the way Uber Eats
/// Manager's multi-location view does. Every order is labelled with its
/// store once there's more than one, since "which kitchen makes this" is
/// the first thing a multi-store owner needs to know.
export function MerchantOrders() {
  const navigate = useNavigate();
  const stores = useMyStores();
  const [filter, setFilter] = useState(ALL_STORES);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [advancingPickup, setAdvancingPickup] = useState<string | null>(null);

  // A store filter that no longer matches anything (e.g. stale state)
  // quietly falls back to everything rather than showing an empty queue.
  const effectiveFilter = stores?.some((s) => s.hex === filter) ? filter : ALL_STORES;
  const visibleStores = useMemo<StoreRow[]>(
    () => (stores ?? []).filter((s) => effectiveFilter === ALL_STORES || s.hex === effectiveFilter),
    [stores, effectiveFilter],
  );
  const storeName = useMemo(() => new Map((stores ?? []).map((s) => [s.hex, s.catalog.business_name])), [stores]);

  // Both queues for exactly the stores on screen, keyed by that set -- a
  // slow reply for the filter you just switched away from is dropped
  // rather than shown under the new one. Every dispatch signal (new order,
  // status change, ...) triggers a re-read; polling backs signals up.
  const queueKey = stores ? `merchant-orders:${visibleStores.map((s) => s.hex).join(",")}` : null;
  const { data: queues, reload } = useResource(
    queueKey,
    async () => {
      const perStore = await Promise.all(
        visibleStores.map(async (store) => {
          const [deliveries, pickups] = await Promise.all([getOrdersForStore(store.hash), getPickupOrdersForStore(store.hash)]);
          return {
            rows: deliveries.map((r): Row => ({ hash: actionHash(r), order: decodeEntry<DeliveryOrder>(r), storeHex: store.hex })),
            pickupRows: pickups.map((r): PickupRow => ({ hash: actionHash(r), order: decodeEntry<PickupOrder>(r), storeHex: store.hex })),
          };
        }),
      );
      const rows = perStore.flatMap((p) => p.rows).sort((a, b) => b.order.requested_at - a.order.requested_at);
      const pickupRows = perStore.flatMap((p) => p.pickupRows).sort((a, b) => b.order.requested_at - a.order.requested_at);
      return { rows, pickupRows };
    },
    { pollMs: POLL_MS, refreshOn: () => true },
  );
  const rows = queues?.rows ?? null;
  const pickupRows = queues?.pickupRows ?? null;

  async function confirmPrep(hash: Uint8Array) {
    setConfirming(bytesToHex(hash));
    try {
      await setOrderStatus(hash, "MerchantConfirmed");
      await reload();
    } finally {
      setConfirming(null);
    }
  }

  async function advancePickup(hash: Uint8Array, action: (h: Uint8Array) => Promise<unknown>) {
    setAdvancingPickup(bytesToHex(hash));
    try {
      await action(hash);
      await reload();
    } finally {
      setAdvancingPickup(null);
    }
  }

  if (stores !== null && stores.length === 0) {
    return (
      <div className="flex flex-col items-center px-4">
        <EmptyState icon={<Store size={32} />} title="No storefront yet" subtitle="Publish a storefront to start receiving orders." />
        <Button onClick={() => navigate("/merchant/catalog")}>Set up your store</Button>
      </div>
    );
  }

  const multiStore = (stores?.length ?? 0) > 1;
  const storeFilter = multiStore && stores && (
    <ChipRow>
      <Chip active={effectiveFilter === ALL_STORES} onClick={() => setFilter(ALL_STORES)} tone="brand">
        All stores
      </Chip>
      {stores.map((s) => (
        <Chip key={s.hex} active={effectiveFilter === s.hex} onClick={() => setFilter(s.hex)} tone="brand">
          {s.catalog.business_name}
        </Chip>
      ))}
    </ChipRow>
  );
  const storeLabel = (hex: string) =>
    multiStore && (
      <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-relay-600">
        <Store size={11} /> {storeName.get(hex) ?? "Store"}
      </p>
    );

  if (rows === null || pickupRows === null) {
    return (
      <div className="px-4 pt-4 pb-8">
        <Skeleton className="h-7 w-1/2 mb-4" />
        <Skeleton className="h-28 w-full mb-3" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  if (rows.length === 0 && pickupRows.length === 0) {
    return (
      <div className="px-4 pt-4">
        {storeFilter}
        <EmptyState
          icon={<ClipboardList size={32} />}
          title="No orders yet"
          subtitle={effectiveFilter === ALL_STORES ? "New orders for your stores show up here automatically." : "New orders for this store show up here automatically."}
        />
      </div>
    );
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4 pb-8">
      <motion.h1 variants={fadeSlideUp} className="mb-4 text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">
        Incoming orders
      </motion.h1>
      {storeFilter}
      {rows.length > 0 && <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">Delivery orders</p>}
      <div className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {rows.map(({ hash, order, storeHex }) => (
            <motion.div key={bytesToHex(hash)} layout variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0 }}>
              <Card className="p-4">
                {storeLabel(storeHex)}
                <div className="flex items-center justify-between">
                  <StatNumber className="text-sm">{formatCents(order.order_total)}</StatNumber>
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
                  <p className="mt-2 text-xs text-ink-400">Driver is on the way to pick this up. Stay connected so they can confirm the handoff with you directly.</p>
                )}
              </Card>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {pickupRows.length > 0 && <p className="mb-2 mt-5 text-xs font-bold uppercase tracking-wide text-ink-400">Pickup orders</p>}
      <div className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {pickupRows.map(({ hash, order, storeHex }) => (
            <motion.div key={bytesToHex(hash)} layout variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0 }}>
              <Card className="p-4">
                {storeLabel(storeHex)}
                <div className="flex items-center justify-between">
                  <StatNumber className="text-sm">{formatCents(order.order_total)}</StatNumber>
                  <PickupStatusBadge status={order.status} />
                </div>
                <p className="mt-1 text-xs text-ink-400">{order.item_refs.length} item{order.item_refs.length === 1 ? "" : "s"}</p>
                {order.special_instructions && <p className="mt-1 text-xs italic text-ink-500">"{order.special_instructions}"</p>}
                {order.status === "Placed" && (
                  <Button className="mt-3 w-full py-2 text-xs" loading={advancingPickup === bytesToHex(hash)} onClick={() => advancePickup(hash, confirmPickupPrep)}>
                    Confirm prep started
                  </Button>
                )}
                {order.status === "MerchantConfirmed" && (
                  <Button className="mt-3 w-full py-2 text-xs" loading={advancingPickup === bytesToHex(hash)} onClick={() => advancePickup(hash, markReadyForPickup)}>
                    Mark ready for pickup
                  </Button>
                )}
                {order.status === "ReadyForPickup" && <p className="mt-2 text-xs text-ink-400">Waiting for the customer to collect it.</p>}
              </Card>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
