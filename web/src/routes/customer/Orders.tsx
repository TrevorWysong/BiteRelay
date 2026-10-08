import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bike, ClipboardList, PackageOpen, Pause, Play, PlayCircle, Repeat, RotateCcw, ShoppingBag } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { getMyActiveOrders, getMyOrderHistory, openScheduledOrder, listMyRecurringTemplates, setRecurringTemplateActive } from "../../holochain/zomes/dispatch";
import { getCatalog, getMyBagClaims, getGoodieBag } from "../../holochain/zomes/catalog";
import { decodeEntry, actionHash, bytesEqual, bytesToHex } from "../../holochain/decode";
import { useCart } from "../../store/cart";
import { useResource } from "../../lib/useResource";
import { fetchMenu } from "../../lib/menu";
import { customerOrderPath, isFinished, itemCount, mergeNewestFirst, toOrderRow, type OrderRow } from "../../lib/orderEntries";
import { Button, Card, EmptyState, SegmentedTabs, Skeleton, StatNumber } from "../../components/ui";
import { StatusBadge, PickupStatusBadge } from "../../components/OrderStatus";
import { formatCents, timeAgo } from "../../lib/format";
import { describeRecurrence } from "../../lib/recurrence";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import type { BagClaim, GoodieBag, MerchantCatalog, RecurringOrderTemplate, Timestamp } from "../../holochain/types";

const POLL_MS = 8000;

const TABS = [
  { value: "active", label: "In progress" },
  { value: "past", label: "Past" },
] as const;

/// A customer's orders the way DoorDash/Uber Eats show them: what's **in
/// progress** (polled, and re-read on every dispatch signal -- cheap, since
/// the active queue only holds unfinished orders) and **past** orders
/// (newest first, paginated, read on demand). Both come from the
/// customer's own queues (see `dispatch_integrity::order_queues`), so
/// neither ever reads their whole order history at once.
export function Orders() {
  const [tab, setTab] = useState<"active" | "past">("active");
  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-4 pb-8">
      <motion.div variants={fadeSlideUp} className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">Your orders</h1>
        <SegmentedTabs tabs={TABS} value={tab} onChange={setTab} />
      </motion.div>
      <RecurringOrders />
      {tab === "active" ? <ActiveOrders /> : <PastOrders />}
    </motion.div>
  );
}

function ActiveOrders() {
  const [opening, setOpening] = useState<string | null>(null);
  // `checkedAt` is when this snapshot was read -- what "is a scheduled
  // order due yet" is judged against, refreshed with every poll.
  const { data, reload } = useResource(
    "customer-active-orders",
    async () => ({ rows: (await getMyActiveOrders()).map(toOrderRow), checkedAt: Date.now() * 1000 }),
    { pollMs: POLL_MS, refreshOn: () => true },
  );
  const rows = data?.rows;

  async function openNow(row: OrderRow) {
    setOpening(row.hex);
    try {
      await openScheduledOrder(row.ref);
      await reload();
    } catch {
      // Most likely "too early" -- validation is the real enforcement; this
      // button only appears once the time has passed, so a failure here is
      // a clock-skew edge, not worth an error banner.
    } finally {
      setOpening(null);
    }
  }

  if (rows === undefined) return <ListSkeleton />;
  return (
    <>
      <PendingClaims />
      {rows.length === 0 ? (
        <EmptyState icon={<ClipboardList size={32} />} title="No orders in progress" subtitle="Place one from Browse to track it here." />
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatePresence initial={false}>
            {rows.map((row) => {
              const scheduledDue = row.kind === "Delivery" && row.order.status === "Scheduled" && row.order.requested_delivery_time !== null && row.order.requested_delivery_time <= data!.checkedAt;
              return (
                <motion.div key={row.hex} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <OrderCard row={row}>
                    {scheduledDue && (
                      <Button variant="primary" className="px-2.5 py-1.5 text-xs" loading={opening === row.hex} onClick={() => openNow(row)}>
                        <PlayCircle size={13} /> Send now
                      </Button>
                    )}
                  </OrderCard>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </>
  );
}

interface PastState {
  rows: OrderRow[];
  nextBefore: Timestamp | null;
}

/// Finished orders, newest first. History holds every order, so in-progress
/// ones are filtered out here (they're on the other tab) -- a page can come
/// back shorter than its limit, which "Load more" handles like any other.
function PastOrders() {
  const [loadingMore, setLoadingMore] = useState(false);
  const { data, mutate } = useResource<PastState>("customer-order-history", () => fetchPast(null));

  async function loadMore() {
    if (!data?.nextBefore) return;
    setLoadingMore(true);
    try {
      const next = await fetchPast(data.nextBefore);
      mutate((prev) => ({ rows: mergeNewestFirst(prev?.rows ?? [], next.rows), nextBefore: next.nextBefore }));
    } finally {
      setLoadingMore(false);
    }
  }

  if (data === undefined) return <ListSkeleton />;
  if (data.rows.length === 0 && data.nextBefore === null) {
    return <EmptyState icon={<ClipboardList size={32} />} title="No past orders" subtitle="Orders you've received or cancelled show up here." />;
  }
  return (
    <div className="flex flex-col gap-3">
      {data.rows.map((row) => (
        <OrderCard key={row.hex} row={row} showTime>
          <ReorderButton row={row} />
        </OrderCard>
      ))}
      {data.nextBefore !== null && (
        <Button variant="ghost" loading={loadingMore} onClick={loadMore} className="w-full py-2 text-xs">
          Load more
        </Button>
      )}
    </div>
  );
}

async function fetchPast(before: Timestamp | null): Promise<PastState> {
  const page = await getMyOrderHistory(before);
  return { rows: page.orders.map(toOrderRow).filter(isFinished), nextBefore: page.next_before };
}

function OrderCard({ row, showTime, children }: { row: OrderRow; showTime?: boolean; children?: React.ReactNode }) {
  const count = itemCount(row.order);
  return (
    <Card className="flex items-center gap-2 p-4">
      <Link to={customerOrderPath(row)} className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
          <span className={clsx("flex items-center gap-1", row.kind === "Delivery" ? "text-relay-600" : "text-presence-600")}>
            {row.kind === "Delivery" ? <Bike size={11} /> : <ShoppingBag size={11} />}
            {row.kind}
          </span>
          {showTime && <span className="font-normal normal-case tracking-normal text-ink-300">{timeAgo(row.order.requested_at)}</span>}
        </div>
        <StatNumber className="text-sm">{formatCents(row.order.order_total)}</StatNumber>
        <p className="text-xs text-ink-400">
          {count} item{count === 1 ? "" : "s"}
        </p>
      </Link>
      {row.kind === "Delivery" ? <StatusBadge status={row.order.status} /> : <PickupStatusBadge status={row.order.status} />}
      {children}
    </Card>
  );
}

/// Rebuilds the cart from a past order against the store's *current* menu:
/// an item since removed is dropped and a repriced one takes its new price,
/// rather than failing the whole reorder over one stale line.
function ReorderButton({ row }: { row: OrderRow }) {
  const cart = useCart();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function reorder() {
    const { order } = row;
    setBusy(true);
    try {
      const [catalogRecord, menuItems] = await Promise.all([getCatalog(order.catalog_ref), fetchMenu(order.catalog_ref)]);
      const catalog = decodeEntry<MerchantCatalog>(catalogRecord);
      const lines = order.lines.map((line) => ({ itemRef: line.item_ref, quantity: line.quantity })).flatMap(({ itemRef, quantity }) => {
        const menuItem = menuItems.find((m) => bytesEqual(m.hash, itemRef));
        return menuItem ? [{ itemRef, name: menuItem.item.name, priceCents: menuItem.item.price_cents, quantity }] : [];
      });
      cart.setCart(order.catalog_ref, order.merchant, catalog.business_name, lines);
      navigate("/customer/cart");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="ghost" className="px-2.5 py-1.5 text-xs" loading={busy} onClick={reorder} aria-label="Reorder">
      <RotateCcw size={13} />
    </Button>
  );
}

/// Claims the merchant hasn't confirmed yet. Once confirmed, a claim is
/// turned into a real order automatically (see useClaimFinalization) and
/// shows up as an order instead.
function PendingClaims() {
  const { data: claims } = useResource(
    "customer-pending-claims",
    async () => {
      const pending = (await getMyBagClaims()).map((c) => ({ hash: actionHash(c.record), claim: decodeEntry<BagClaim>(c.record) })).filter((c) => c.claim.status === "Pending");
      return Promise.all(
        pending.map(async ({ hash, claim }) => ({
          hex: bytesToHex(hash),
          title: await getGoodieBag(claim.bag_ref)
            .then((r) => decodeEntry<GoodieBag>(r).title)
            .catch(() => "Goodie bag"),
        })),
      );
    },
    { pollMs: POLL_MS, refreshOn: () => true },
  );
  if (!claims?.length) return null;
  return (
    <div className="mb-5">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
        <PackageOpen size={13} className="text-relay-500" /> Pending goodie bag claims
      </p>
      <div className="flex flex-col gap-2">
        {claims.map((claim) => (
          <Card key={claim.hex} className="p-3.5">
            <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{claim.title}</p>
            <p className="text-xs text-ink-400">Waiting for the store to confirm</p>
          </Card>
        ))}
      </div>
    </div>
  );
}

/// Recurring templates only change through this section's own toggle
/// (which reloads them), so they're read once, not polled.
function RecurringOrders() {
  const [toggling, setToggling] = useState<string | null>(null);
  const { data: templates, reload } = useResource("customer-recurring", async () =>
    Promise.all(
      (await listMyRecurringTemplates()).map(async (view) => {
        const template = decodeEntry<RecurringOrderTemplate>(view.record);
        const storeName = await getCatalog(template.catalog_ref)
          .then((cr) => decodeEntry<MerchantCatalog>(cr).business_name)
          .catch(() => "Restaurant");
        return { hash: view.original_action, hex: bytesToHex(view.original_action), template, storeName };
      }),
    ),
  );

  async function toggle(hash: Uint8Array, hex: string, active: boolean) {
    setToggling(hex);
    try {
      await setRecurringTemplateActive(hash, !active);
      await reload();
    } finally {
      setToggling(null);
    }
  }

  if (!templates?.length) return null;
  return (
    <div className="mb-5">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
        <Repeat size={13} /> Recurring orders
      </p>
      <div className="flex flex-col gap-2">
        {templates.map(({ hash, hex, template, storeName }) => (
          <Card key={hex} className="flex items-center justify-between p-3.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{storeName}</p>
              <p className="text-xs text-ink-400">{describeRecurrence(template.recurrence)}</p>
            </div>
            <Button variant={template.active ? "secondary" : "ghost"} className="px-3 py-1.5 text-xs" loading={toggling === hex} onClick={() => toggle(hash, hex, template.active)}>
              {template.active ? <Pause size={13} /> : <Play size={13} />} {template.active ? "Active" : "Paused"}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div>
      <Skeleton className="h-16 w-full mb-3" />
      <Skeleton className="h-16 w-full mb-3" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}
