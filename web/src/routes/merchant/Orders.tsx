import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bike, ClipboardList, ShoppingBag, Store } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { getActiveOrdersForStore, getOrderHistoryForStore, setOrderStatus, confirmPickupPrep, markReadyForPickup, type OrderEntry } from "../../holochain/zomes/dispatch";
import { mergeNewestFirst, toOrderRow, type OrderRow } from "../../lib/orderEntries";
import { useMyStores, type StoreRow } from "../../store/merchantStores";
import { useResource } from "../../lib/useResource";
import { Button, Card, Chip, ChipRow, EmptyState, SegmentedTabs, Skeleton, StatNumber } from "../../components/ui";
import { StatusBadge, PickupStatusBadge } from "../../components/OrderStatus";
import { formatCents, timeAgo } from "../../lib/format";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import type { Timestamp } from "../../holochain/types";

const POLL_MS = 8000;

const TABS = [
  { value: "active", label: "Active" },
  { value: "history", label: "History" },
] as const;

/// "All stores" isn't a store hex, so it can't collide with one.
const ALL_STORES = "all";

/// An order, labelled with the store it came in at.
type QueueRow = OrderRow & { storeHex: string };

function toRow(entry: OrderEntry, storeHex: string): QueueRow {
  return { ...toOrderRow(entry), storeHex };
}

const storesKey = (stores: StoreRow[]) => stores.map((s) => s.hex).join(",");

/// A merchant's orders across every store they run, the way a DoorDash/
/// Uber Eats store tablet splits them: the **active** queue (what the
/// kitchen is working on, oldest first, polled) and **history** (every
/// order, newest first, paginated, read on demand). Each store's queues are
/// its own on the DHT (see `dispatch_integrity::order_queues`); with several
/// stores, every order is labelled with its store, since "which kitchen
/// makes this" is the first thing a multi-store owner needs to know.
export function MerchantOrders() {
  const navigate = useNavigate();
  const stores = useMyStores();
  const [filter, setFilter] = useState(ALL_STORES);
  const [tab, setTab] = useState<"active" | "history">("active");

  // A store filter that no longer matches anything (e.g. stale state)
  // quietly falls back to everything rather than showing an empty queue.
  const effectiveFilter = stores?.some((s) => s.hex === filter) ? filter : ALL_STORES;
  const visibleStores = useMemo(() => (stores ?? []).filter((s) => effectiveFilter === ALL_STORES || s.hex === effectiveFilter), [stores, effectiveFilter]);
  const storeName = useMemo(() => new Map((stores ?? []).map((s) => [s.hex, s.catalog.business_name])), [stores]);
  const multiStore = (stores?.length ?? 0) > 1;

  if (stores === null) return <QueueSkeleton />;
  if (stores.length === 0) {
    return (
      <div className="flex flex-col items-center px-4">
        <EmptyState icon={<Store size={32} />} title="No storefront yet" subtitle="Publish a storefront to start receiving orders." />
        <Button onClick={() => navigate("/merchant/catalog")}>Set up your store</Button>
      </div>
    );
  }

  const label = (hex: string) => (multiStore ? (storeName.get(hex) ?? "Store") : null);
  const scope = effectiveFilter === ALL_STORES ? "your stores" : "this store";

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4 pb-8">
      <motion.div variants={fadeSlideUp} className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">Orders</h1>
        <SegmentedTabs tabs={TABS} value={tab} onChange={setTab} />
      </motion.div>
      {multiStore && (
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
      )}
      {/* Keyed by the stores shown: changing the filter mounts a fresh list
          (and, for history, fresh pagination) instead of resetting state. */}
      {tab === "active" ? (
        <ActiveQueue key={storesKey(visibleStores)} stores={visibleStores} storeLabel={label} scope={scope} />
      ) : (
        <OrderHistory key={storesKey(visibleStores)} stores={visibleStores} storeLabel={label} scope={scope} />
      )}
    </motion.div>
  );
}

function QueueSkeleton() {
  return (
    <div className="px-4 pt-4 pb-8">
      <Skeleton className="h-7 w-1/2 mb-4" />
      <Skeleton className="h-28 w-full mb-3" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

interface ListProps {
  stores: StoreRow[];
  storeLabel: (storeHex: string) => string | null;
  scope: string;
}

/// Polled, and re-read on every dispatch signal (a new order, a status
/// change) -- cheap because the active queue only ever holds in-progress
/// orders. Oldest first: the order a kitchen works through them.
function ActiveQueue({ stores, storeLabel, scope }: ListProps) {
  const [busyHex, setBusyHex] = useState<string | null>(null);
  const { data: rows, reload } = useResource(
    `merchant-active:${storesKey(stores)}`,
    async () => {
      const perStore = await Promise.all(stores.map(async (store) => (await getActiveOrdersForStore(store.hash)).map((entry) => toRow(entry, store.hex))));
      return perStore.flat().sort((a, b) => a.order.requested_at - b.order.requested_at);
    },
    { pollMs: POLL_MS, refreshOn: () => true },
  );

  async function advance(row: QueueRow, action: (ref: Uint8Array) => Promise<unknown>) {
    setBusyHex(row.hex);
    try {
      await action(row.ref);
      await reload();
    } finally {
      setBusyHex(null);
    }
  }

  if (rows === undefined) return <QueueSkeleton />;
  if (rows.length === 0) {
    return <EmptyState icon={<ClipboardList size={32} />} title="No active orders" subtitle={`New orders for ${scope} show up here automatically.`} />;
  }
  return (
    <div className="flex flex-col gap-3">
      <AnimatePresence initial={false}>
        {rows.map((row) => (
          <motion.div key={row.hex} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <OrderCard row={row} storeLabel={storeLabel(row.storeHex)}>
              <ActiveActions row={row} busy={busyHex === row.hex} onAdvance={(action) => advance(row, action)} />
            </OrderCard>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/// What the merchant can do next for an in-progress order, or what they're
/// waiting on.
function ActiveActions({ row, busy, onAdvance }: { row: QueueRow; busy: boolean; onAdvance: (action: (ref: Uint8Array) => Promise<unknown>) => void }) {
  const button = (label: string, action: (ref: Uint8Array) => Promise<unknown>) => (
    <Button className="mt-3 w-full py-2 text-xs" loading={busy} onClick={() => onAdvance(action)}>
      {label}
    </Button>
  );
  const note = (text: string) => <p className="mt-2 text-xs text-ink-400">{text}</p>;
  if (row.kind === "Delivery") {
    switch (row.order.status) {
      case "BidAccepted":
        return button("Confirm prep started", (ref) => setOrderStatus(ref, "MerchantConfirmed"));
      case "Open":
        return note("Waiting for a driver to be assigned.");
      case "Scheduled":
        return note("Scheduled for later -- it opens to drivers at its requested time.");
      case "MerchantConfirmed":
      case "DriverEnRouteToMerchant":
        return note("Driver is on the way to pick this up. Stay connected so they can confirm the handoff with you directly.");
      case "PickedUp":
        return note("Out for delivery.");
      default:
        return null;
    }
  }
  switch (row.order.status) {
    case "Placed":
      return button("Confirm prep started", confirmPickupPrep);
    case "MerchantConfirmed":
      return button("Mark ready for pickup", markReadyForPickup);
    case "ReadyForPickup":
      return note("Waiting for the customer to collect it.");
    default:
      return null;
  }
}

interface HistoryState {
  rows: QueueRow[];
  /// Per store: where its next page starts, or null once it's exhausted.
  cursors: Record<string, Timestamp | null>;
}

/// Every order, newest first, a page per store at a time -- never polled
/// (history doesn't change under you), and each "Load more" only reads the
/// next page of each store that still has one.
function OrderHistory({ stores, storeLabel, scope }: ListProps) {
  const [loadingMore, setLoadingMore] = useState(false);
  const { data, mutate } = useResource<HistoryState>(`merchant-history:${storesKey(stores)}`, () => fetchHistoryPages(stores, null));
  const hasMore = !!data && Object.values(data.cursors).some((cursor) => cursor !== null);

  async function loadMore() {
    if (!data) return;
    setLoadingMore(true);
    try {
      const next = await fetchHistoryPages(stores.filter((s) => data.cursors[s.hex] !== null), data.cursors);
      mutate((prev) => ({
        rows: mergeNewestFirst(prev?.rows ?? [], next.rows),
        cursors: { ...(prev?.cursors ?? {}), ...next.cursors },
      }));
    } finally {
      setLoadingMore(false);
    }
  }

  if (data === undefined) return <QueueSkeleton />;
  if (data.rows.length === 0) return <EmptyState icon={<ClipboardList size={32} />} title="No orders yet" subtitle={`Every order ${scope} receives will be listed here.`} />;
  return (
    <div className="flex flex-col gap-3">
      {data.rows.map((row) => (
        <OrderCard key={row.hex} row={row} storeLabel={storeLabel(row.storeHex)} showTime />
      ))}
      {hasMore && (
        <Button variant="ghost" loading={loadingMore} onClick={loadMore} className="w-full py-2 text-xs">
          Load more
        </Button>
      )}
    </div>
  );
}

async function fetchHistoryPages(stores: StoreRow[], cursors: Record<string, Timestamp | null> | null): Promise<HistoryState> {
  const pages = await Promise.all(stores.map(async (store) => ({ store, page: await getOrderHistoryForStore(store.hash, cursors?.[store.hex] ?? null) })));
  return {
    rows: mergeNewestFirst([], pages.flatMap(({ store, page }) => page.orders.map((entry) => toRow(entry, store.hex)))),
    cursors: Object.fromEntries(pages.map(({ store, page }) => [store.hex, page.next_before])),
  };
}

function OrderCard({ row, storeLabel, showTime, children }: { row: QueueRow; storeLabel: string | null; showTime?: boolean; children?: React.ReactNode }) {
  const { order } = row;
  const itemCount = order.item_refs.length;
  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
        <span className={clsx("flex items-center gap-1", row.kind === "Delivery" ? "text-relay-600" : "text-presence-600")}>
          {row.kind === "Delivery" ? <Bike size={11} /> : <ShoppingBag size={11} />}
          {row.kind === "Delivery" ? "Delivery" : "Pickup"}
        </span>
        {storeLabel && (
          <span className="flex items-center gap-1 text-ink-400">
            <Store size={11} /> {storeLabel}
          </span>
        )}
        {showTime && <span className="ml-auto font-normal normal-case tracking-normal text-ink-300">{timeAgo(order.requested_at)}</span>}
      </div>
      <div className="flex items-center justify-between">
        <StatNumber className="text-sm">{formatCents(order.order_total)}</StatNumber>
        {row.kind === "Delivery" ? <StatusBadge status={row.order.status} /> : <PickupStatusBadge status={row.order.status} />}
      </div>
      <p className="mt-1 text-xs text-ink-400">
        {itemCount} item{itemCount === 1 ? "" : "s"}
      </p>
      {order.special_instructions && <p className="mt-1 text-xs italic text-ink-500">"{order.special_instructions}"</p>}
      {children}
    </Card>
  );
}
