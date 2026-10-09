import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bike, ClipboardList, ShoppingBag, Store } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import {
  acceptDeliveryOrder,
  acceptPickupOrder,
  declineOrder,
  declinePickupOrder,
  getOrderHistoryForStore,
  getOrderPrivateDetails,
  markReadyForPickup,
  setOrderStatus,
} from "../../holochain/zomes/dispatch";
import { isFinished, itemCount, mergeNewestFirst } from "../../lib/orderEntries";
import { useMyStores, type StoreRow } from "../../store/merchantStores";
import { fetchActiveQueue, storesKey, toRow, type QueueRow } from "../../store/merchantQueue";
import { useResource } from "../../lib/useResource";
import { describeError } from "../../lib/errors";
import { DECLINE_REASONS, responseDeadlineMs } from "../../lib/storeAnswers";
import { useStoreResponseSecs } from "../../lib/useStoreResponseSecs";
import { ResponseCountdown } from "../../components/ResponseCountdown";
import { Button, Card, Chip, ChipRow, EmptyState, SegmentedTabs, Skeleton, StatNumber } from "../../components/ui";
import { StatusBadge, PickupStatusBadge } from "../../components/OrderStatus";
import { formatCents, formatClockTime, timeAgo } from "../../lib/format";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import type { Timestamp } from "../../holochain/types";
import { POLL, isOrderSignal } from "../../lib/poll";
import { acknowledgeLeg } from "../../holochain/zomes/attestation";
import { CustomerHistory } from "../../components/CustomerHistory";
import { OrderIssues } from "../../components/OrderIssues";
import { unconfirmedPickup } from "../../lib/handoffs";


const TABS = [
  { value: "active", label: "Active" },
  { value: "history", label: "History" },
] as const;

/// "All stores" isn't a store hex, so it can't collide with one.
const ALL_STORES = "all";

/// The prep times a kitchen picks from when it accepts an order.
const PREP_CHOICES = [5, 10, 15, 20, 30, 45, 60];
const DEFAULT_PREP_MINUTES = 15;

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
  // Why an action on an order failed, by order -- e.g. an order the store
  // can't accept because it's priced from an outdated menu.
  const [errors, setErrors] = useState<Record<string, string>>({});
  const windowSecs = useStoreResponseSecs();
  // `now` is when this snapshot was read -- what each order's window is
  // judged against, refreshed with every poll.
  const { data, reload } = useResource(`merchant-active:${storesKey(stores)}`, async () => ({ rows: await fetchActiveQueue(stores), now: Date.now() }), {
    pollMs: POLL.signalled,
    refreshOn: isOrderSignal,
  });
  const rows = data?.rows;
  async function advance(row: QueueRow, action: OrderAction) {
    setBusyHex(row.hex);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[row.hex];
      return next;
    });
    try {
      await action(row.ref);
      await reload();
    } catch (err) {
      setErrors((prev) => ({ ...prev, [row.hex]: describeError(err) }));
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
              {errors[row.hex] && (
                <p className="mt-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">{errors[row.hex]}</p>
              )}
              {row.order.status === "Placed" && windowSecs !== undefined ? (
                <AnswerOrder
                  row={row}
                  windowSecs={windowSecs}
                  now={data!.now}
                  defaultPrep={stores.find((s) => s.hex === row.storeHex)?.catalog.prep_minutes ?? DEFAULT_PREP_MINUTES}
                  busy={busyHex === row.hex}
                  onAdvance={(action) => advance(row, action)}
                />
              ) : (
                <ActiveActions row={row} busy={busyHex === row.hex} onAdvance={(action) => advance(row, action)} />
              )}
            </OrderCard>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

type OrderAction = (ref: Uint8Array) => Promise<unknown>;

/// A new order, waiting on the store: Accept -- the store's check that it's
/// priced from the current menu (the zome refuses it otherwise) and, for a
/// delivery, what puts it in front of drivers -- or Decline, with a reason
/// the customer is told. Past the window it can't be accepted; the
/// customer's conductor cancels it.
function AnswerOrder({ row, windowSecs, now, defaultPrep, busy, onAdvance }: { row: QueueRow; windowSecs: number; now: number; defaultPrep: number; busy: boolean; onAdvance: (action: OrderAction) => void }) {
  const [choosingReason, setChoosingReason] = useState(false);
  // How long this one will take -- the store's usual time unless the
  // kitchen picks another; the customer is told when it'll be ready.
  const [prep, setPrep] = useState(defaultPrep);
  const prepChoices = [...new Set([defaultPrep, ...PREP_CHOICES])].sort((a, b) => a - b);
  const deadlineMs = responseDeadlineMs(row.writtenAt, windowSecs);
  if (now >= deadlineMs) {
    return <p className="mt-2 text-xs text-ink-400">Not accepted in time, so the customer's order is being cancelled.</p>;
  }
  const accept: OrderAction = row.kind === "Delivery" ? (ref) => acceptDeliveryOrder(ref, prep) : (ref) => acceptPickupOrder(ref, prep);
  const decline = (reason: (typeof DECLINE_REASONS)[number]["reason"]): OrderAction =>
    row.kind === "Delivery" ? (ref) => declineOrder(ref, reason) : (ref) => declinePickupOrder(ref, reason);
  return (
    <>
      <ResponseCountdown deadlineMs={deadlineMs} windowSecs={windowSecs} now={now} label="Accept by" />
      {choosingReason ? (
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-semibold text-ink-500">Why are you declining? The customer will see this.</p>
          <div className="flex flex-wrap gap-1.5">
            {DECLINE_REASONS.map(({ reason, label }) => (
              <Button key={reason} variant="ghost" className="px-3 py-1.5 text-xs" disabled={busy} onClick={() => onAdvance(decline(reason))}>
                {label}
              </Button>
            ))}
            <Button variant="ghost" className="px-3 py-1.5 text-xs text-ink-400" disabled={busy} onClick={() => setChoosingReason(false)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-1.5 overflow-x-auto no-scrollbar" role="radiogroup" aria-label="Ready in">
            <span className="shrink-0 text-[11px] font-semibold text-ink-500">Ready in</span>
            {prepChoices.map((minutes) => (
              <button
                key={minutes}
                role="radio"
                aria-checked={prep === minutes}
                onClick={() => setPrep(minutes)}
                className={clsx(
                  "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition",
                  prep === minutes ? "bg-ink-900 text-white dark:bg-white dark:text-ink-900" : "bg-ink-100 text-ink-500 dark:bg-ink-800",
                )}
              >
                {minutes} min
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Button variant="ghost" className="flex-1 py-2 text-xs" disabled={busy} onClick={() => setChoosingReason(true)}>
              Decline
            </Button>
            <Button className="flex-[2] py-2 text-xs" loading={busy} onClick={() => onAdvance(accept)}>
              Accept · {prep} min
            </Button>
          </div>
        </>
      )}
    </>
  );
}

/// What the merchant can do next for an order they've accepted, or what
/// they're waiting on.
function ActiveActions({ row, busy, onAdvance }: { row: QueueRow; busy: boolean; onAdvance: (action: OrderAction) => void }) {
  const button = (label: string, action: OrderAction) => (
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
        return note("Scheduled for later -- it comes to you to accept at its requested time.");
      case "MerchantConfirmed":
      case "DriverEnRouteToMerchant":
        return note("Driver is on the way to pick this up. Stay connected so they can confirm the handoff with you directly.");
      case "PickedUp":
        return (
          <>
            {note("Out for delivery.")}
            <ConfirmHandoff orderHex={row.hex} orderRef={row.ref} />
          </>
        );
      default:
        return null;
    }
  }
  switch (row.order.status) {
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
        <OrderCard key={row.hex} row={row} storeLabel={storeLabel(row.storeHex)} showTime>
          {mayHaveOpenIssues(row) && <OrderIssues orderRef={row.ref} role="store" />}
        </OrderCard>
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

/// A day covers an order's 2-hour issue window and the time a store has to
/// answer a late report, with room to spare; older orders aren't checked,
/// which keeps a long history cheap to show.
const ISSUE_LOOKBACK_MICROS = 24 * 60 * 60 * 1_000_000;

function mayHaveOpenIssues(row: QueueRow): boolean {
  const completed = row.kind === "Delivery" ? row.order.status === "Delivered" : row.order.status === "PickedUp";
  return completed && Date.now() * 1000 - row.order.requested_at < ISSUE_LOOKBACK_MICROS;
}

function OrderCard({ row, storeLabel, showTime, children }: { row: QueueRow; storeLabel: string | null; showTime?: boolean; children?: React.ReactNode }) {
  const { order } = row;
  const count = itemCount(order);
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
        {count} item{count === 1 ? "" : "s"}
        {order.ready_by !== null && !isFinished(row) && <span className="font-semibold text-ink-600 dark:text-ink-300"> · ready by {formatClockTime(order.ready_by)}</span>}
      </p>
      {(order.kitchen_note || order.sealed_customer_name) && <ForTheStore orderHex={row.hex} orderRef={row.ref} />}
      {!isFinished(row) && <CustomerHistory customer={order.requester} pinRequired={row.kind === "Delivery" && row.order.pin_required} />}
      {children}
    </Card>
  );
}

/// The store confirming it handed an order to the driver -- its own signed
/// acknowledgment of the driver's pickup, kept as evidence of who had the
/// food when. Optional: a delivery completes without it.
function ConfirmHandoff({ orderHex, orderRef }: { orderHex: string; orderRef: Uint8Array }) {
  const [confirming, setConfirming] = useState(false);
  const { data: pickup, reload } = useResource(`unconfirmed-pickup:${orderHex}`, () => unconfirmedPickup(orderRef));
  if (!pickup) return null;
  async function confirm() {
    setConfirming(true);
    try {
      await acknowledgeLeg(pickup!);
      await reload();
    } finally {
      setConfirming(false);
    }
  }
  return (
    <Button variant="ghost" className="mt-2 w-full py-2 text-xs" loading={confirming} onClick={confirm}>
      Confirm handed to driver
    </Button>
  );
}

/// Who the order's for and their note for the kitchen -- both sealed to
/// the store, opened by the zome. Read once per order: they never change.
function ForTheStore({ orderHex, orderRef }: { orderHex: string; orderRef: Uint8Array }) {
  const { data } = useResource(`for-the-store:${orderHex}`, () => getOrderPrivateDetails(orderRef));
  if (!data) return null;
  return (
    <>
      {data.customer_name && <p className="mt-1 text-xs font-semibold text-ink-700 dark:text-ink-200">For {data.customer_name}</p>}
      {data.kitchen_note && <p className="mt-1 text-xs italic text-ink-500">"{data.kitchen_note}"</p>}
    </>
  );
}
