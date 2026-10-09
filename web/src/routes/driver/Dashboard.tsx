import { useEffect, useRef, useState } from "react";
import { Bike, Link2, MapPin, Power, Route, ShieldCheck } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { getOpenOrdersNear, submitBid, getMyActiveDeliveries, getOrderPrivateDetails, setOrderStatus, sendLocationUpdate, pickUpOrder } from "../../holochain/zomes/dispatch";
import { recordLeg } from "../../holochain/zomes/attestation";
import { decodeEntry, actionHash, bytesToHex, bytesEqual, hexToBytes } from "../../holochain/decode";
import { getCatalog } from "../../holochain/zomes/catalog";
import { planRoute } from "../../lib/route";
import { itemCount } from "../../lib/orderEntries";
import { myAgentPubKey } from "../../holochain/client";
import { encodeGeohash, distanceKm, geohashCenter } from "../../lib/geohash";
import { useSession } from "../../store/session";
import { Button, Card, EmptyState, Input, PresenceDot, Skeleton, StatNumber } from "../../components/ui";
import { OrderStatusTimeline } from "../../components/OrderStatus";
import { StarRating } from "../../components/StarRating";
import { ChatPanel } from "../../components/ChatPanel";
import { PhotoInput } from "../../components/PhotoInput";
import { averageRating, getRatingSummary } from "../../holochain/zomes/reputation";
import { formatCents, formatEta, formatClockTime } from "../../lib/format";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import { describeError } from "../../lib/errors";
import { useResource } from "../../lib/useResource";
import { CustomerHistory } from "../../components/CustomerHistory";
import type { Bid, DeliveryOrder, DeliveryStatus, DropoffDetails, GeoPoint, MerchantCatalog } from "../../holochain/types";
import { POLL, isOrderSignal } from "../../lib/poll";

const DROPOFF_PREFERENCE_LABEL: Record<DeliveryOrder["dropoff_preference"], string> = {
  LeaveAtDoor: "Leave at door",
  HandToMe: "Hand to me",
  MeetOutside: "Meet outside",
};

// Live location is only meaningful once the driver has actually started
// moving on this delivery -- not while still waiting on the merchant to
// confirm prep. 8s matches the "a few seconds, not sub-second" cadence
// named in tracking.rs's own doc comment -- fast enough to feel live,
// far below anything that would stress signal delivery the way a tighter
// interval could.
const TRACKED_STATUSES: DeliveryStatus[] = ["MerchantConfirmed", "DriverEnRouteToMerchant", "PickedUp"];
const LOCATION_BROADCAST_MS = 8000;

/// Browser geolocation, throttled client-side (there's no way to
/// deterministically rate-limit a signal on the backend -- see
/// tracking.rs) and silently inert if the API is unavailable or the user
/// denies permission. Named, not hidden: a driver who never grants
/// location access simply never appears on the customer's live map --
/// everything else about the delivery still works.
function useLocationBroadcast(orderRef: Uint8Array, active: boolean) {
  const lastSentRef = useRef(0);
  useEffect(() => {
    if (!active || !("geolocation" in navigator)) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - lastSentRef.current < LOCATION_BROADCAST_MS) return;
        lastSentRef.current = now;
        sendLocationUpdate(orderRef, pos.coords.latitude, pos.coords.longitude).catch(() => {});
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [orderRef, active]);
}

interface OrderRow {
  /// The order's identity (its original action) -- what every order call takes.
  hash: Uint8Array;
  order: DeliveryOrder;
  bid?: Bid;
  /// The exact drop-off -- opened only for the driver whose bid was
  /// accepted; an open order has just its area (`dropoff_geohash`).
  dropoff?: DropoffDetails | null;
}

/// Where an order's drop-off is, as precisely as this driver may know it.
function dropoffPoint(row: OrderRow): GeoPoint {
  return row.dropoff?.point ?? geohashCenter(row.order.dropoff_geohash);
}

// Nothing in the backend caps concurrent deliveries per driver -- this is a
// deliberate, modest client-side cap: enough to let a driver already on one
// or two deliveries pick up another that's on their way, without
// overcommitting past what one person can carry at once.
const MAX_CONCURRENT_DELIVERIES = 3;

export function DriverDashboard() {
  const location = useSession((s) => s.location);
  const driverKey = myAgentPubKey();
  const driverHex = bytesToHex(driverKey);
  const [online, setOnline] = useState(false);
  const [bidding, setBidding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Driver ratings only -- if this agent also runs a store, that store's
  // reviews live on the store, never here.
  const { data: rating } = useResource(`driver-rating:${driverHex}`, () => getRatingSummary({ Driver: driverKey }));
  const avgRating = rating ? averageRating(rating) : null;

  const geohash = encodeGeohash(location.lat, location.lon);

  // This driver's in-progress deliveries, from their own active-delivery
  // queue -- bounded by what they're carrying right now, never by every
  // bid they've ever placed.
  const { data: activeOrders = [], reload: reloadActive } = useResource(
    `driver-active:${driverHex}`,
    async (): Promise<OrderRow[]> =>
      Promise.all(
        (await getMyActiveDeliveries()).map(async ({ order, bid }) => ({
          hash: order.original_action,
          order: decodeEntry<DeliveryOrder>(order.record),
          bid: decodeEntry<Bid>(bid),
          dropoff: (await getOrderPrivateDetails(order.original_action).catch(() => null))?.dropoff ?? null,
        })),
      ),
    { pollMs: POLL.signalled, refreshOn: (s) => "BidAccepted" in s || "BidReleased" in s || isOrderSignal(s) },
  );

  // Open orders near the driver -- only read while online.
  const { data: nearby } = useResource(
    online ? `driver-nearby:${geohash}` : null,
    async (): Promise<OrderRow[]> => {
      const rows = (await getOpenOrdersNear(geohash)).map((r) => ({ hash: actionHash(r), order: decodeEntry<DeliveryOrder>(r) }));
      // A requester/merchant can't deliver their own order (validate_new_bid
      // rejects it) -- hidden here so they never see a Bid button for one.
      return rows.filter(({ order }) => !bytesEqual(order.requester, driverKey) && !bytesEqual(order.merchant, driverKey));
    },
    // Drivers find orders by looking, never by announcing where they are
    // (see dispatch `matching`) -- so while online, look often, and keep
    // looking in the background so a new order still rings.
    { pollMs: POLL.driverFeed, background: true },
  );

  function toggleOnline() {
    setOnline(!online);
  }

  async function placeBid(orderRef: Uint8Array, etaMinutes: number, feeCents: number) {
    setBidding(bytesToHex(orderRef));
    setError(null);
    try {
      await submitBid({
        order_ref: orderRef,
        eta_seconds: etaMinutes * 60,
        price_offer: feeCents,
      });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBidding(null);
    }
  }

  // Order batching (architecture plan §7's named v2 gap) -- a client-side
  // convenience sort, not real route optimization: there's no way to
  // deterministically validate "is this a good route" inside a zome, and
  // that remains a deliberately open gap. Two zero-fetch signals, both
  // already present on every DeliveryOrder: an exact catalog_ref match
  // (literally the same pickup stop) and drop-off proximity to an order
  // already accepted (clustered drop-offs -- e.g. the same apartment
  // complex), so a driver already committed to one or two deliveries sees
  // the genuinely convenient next pickup first, without this app ever
  // claiming to have computed an optimal route.
  const sameMerchantHexes = new Set(activeOrders.map((r) => bytesToHex(r.order.catalog_ref)));
  // An open order is known only by its area; the deliveries already
  // accepted, exactly.
  function nearestActiveDropoffKm(order: DeliveryOrder): number | null {
    if (activeOrders.length === 0) return null;
    const area = geohashCenter(order.dropoff_geohash);
    return Math.min(...activeOrders.map((a) => distanceKm(area, dropoffPoint(a))));
  }
  const sortedNearby = online && nearby
    ? [...nearby].sort((a, b) => {
        const aSame = sameMerchantHexes.has(bytesToHex(a.order.catalog_ref));
        const bSame = sameMerchantHexes.has(bytesToHex(b.order.catalog_ref));
        if (aSame !== bSame) return aSame ? -1 : 1;
        const aDist = nearestActiveDropoffKm(a.order) ?? Infinity;
        const bDist = nearestActiveDropoffKm(b.order) ?? Infinity;
        return aDist - bDist;
      })
    : null;

  return (
    <div className="px-4 pt-4 pb-8">
      <Card className="mb-5 flex items-center justify-between p-4">
        <div>
          <p className="flex items-center gap-2 text-sm font-bold text-ink-900 dark:text-ink-50">
            <PresenceDot live={online} />
            {online ? "You're online" : "You're offline"}
          </p>
          <p className="text-xs text-ink-400">{online ? "Nearby customers can see and signal you directly" : "Go online to start receiving orders"}</p>
          {avgRating !== null && rating && <StarRating value={avgRating} count={rating.count} size={11} />}
        </div>
        <motion.button
          onClick={toggleOnline}
          aria-label={online ? "Go offline" : "Go online"}
          whileTap={{ scale: 0.92 }}
          animate={{ backgroundColor: online ? "#22c55e" : "#ece9e6" }}
          transition={{ duration: 0.25 }}
          className={`grid h-11 w-11 place-items-center rounded-full ${online ? "text-white shadow-[var(--shadow-glow)]" : "text-ink-400"}`}
          style={online ? { boxShadow: "0 6px 20px -4px rgba(34, 197, 94, 0.5)" } : undefined}
        >
          <Power size={20} />
        </motion.button>
      </Card>

      <AnimatePresence initial={false}>
        {activeOrders.length > 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mb-5 flex flex-col gap-4">
            <p className="text-xs font-bold uppercase tracking-wide text-relay-600">
              Active {activeOrders.length === 1 ? "delivery" : `deliveries (${activeOrders.length})`}
            </p>
            {activeOrders.length > 1 && <SuggestedRoute orders={activeOrders} location={location} />}
            {activeOrders.map((row) => (
              <motion.div key={bytesToHex(row.hash)} layout variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0, scale: 0.97 }}>
                <ActiveDeliveryCard row={row} location={location} onAdvanced={reloadActive} />
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {online && activeOrders.length < MAX_CONCURRENT_DELIVERIES && (
        <>
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-ink-400">
            <MapPin size={14} className="text-relay-500" />
            Nearby open orders
          </div>
          {sortedNearby === null && (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i} className="p-4">
                  <Skeleton className="h-4 w-1/3 mb-2" />
                  <Skeleton className="h-3 w-2/3 mb-3" />
                  <Skeleton className="h-8 w-full" />
                </Card>
              ))}
            </div>
          )}
          {sortedNearby?.length === 0 && <EmptyState icon={<Bike size={28} />} title="No open orders nearby" subtitle="This refreshes automatically as new orders are placed near you." />}
          <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="flex flex-col gap-3">
            {sortedNearby?.map(({ hash, order }) => (
              <motion.div key={bytesToHex(hash)} variants={fadeSlideUp} layout>
                <BidCard
                  order={order}
                  loading={bidding === bytesToHex(hash)}
                  onBid={(eta, fee) => placeBid(hash, eta, fee)}
                  sameMerchant={sameMerchantHexes.has(bytesToHex(order.catalog_ref))}
                  nearbyDropoffKm={nearestActiveDropoffKm(order)}
                />
              </motion.div>
            ))}
          </motion.div>
        </>
      )}

      {online && activeOrders.length >= MAX_CONCURRENT_DELIVERIES && (
        <p className="rounded-xl bg-ink-100/60 dark:bg-ink-800/60 px-4 py-3 text-center text-xs text-ink-400">
          You're at your {MAX_CONCURRENT_DELIVERIES}-delivery limit. Finish one to see new nearby orders again.
        </p>
      )}

      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}

/// The order to make this driver's stops in -- see `planRoute`. Stores'
/// locations are read once per set of stores being served.
function SuggestedRoute({ orders, location }: { orders: OrderRow[]; location: GeoPoint }) {
  const storeHexes = [...new Set(orders.map((row) => bytesToHex(row.order.catalog_ref)))].sort();
  const { data: stores } = useResource(`route-stores:${storeHexes.join(",")}`, async () => {
    const entries = await Promise.all(
      storeHexes.map(async (hex) => {
        const catalog = decodeEntry<MerchantCatalog>(await getCatalog(hexToBytes(hex)));
        return [hex, { name: catalog.business_name, at: catalog.location }] as const;
      }),
    );
    return Object.fromEntries(entries);
  });
  if (!stores) return null;

  const byHex = new Map(orders.map((row) => [bytesToHex(row.hash), row]));
  const stops = planRoute(
    location,
    orders.map((row) => ({
      id: bytesToHex(row.hash),
      pickup: row.order.status === "PickedUp" ? null : (stores[bytesToHex(row.order.catalog_ref)]?.at ?? null),
      dropoff: dropoffPoint(row),
    })),
  );
  return (
    <Card className="p-4">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
        <Route size={13} /> Suggested route
      </p>
      <ol className="flex flex-col gap-1.5">
        {stops.map((stop, i) => {
          const order = byHex.get(stop.id)!.order;
          const label = stop.kind === "pickup" ? `Pick up at ${stores[bytesToHex(order.catalog_ref)]?.name ?? "the store"}` : `Drop off (${DROPOFF_PREFERENCE_LABEL[order.dropoff_preference].toLowerCase()})`;
          return (
            <li key={`${stop.id}-${stop.kind}`} className="flex items-center gap-2 text-sm">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-relay-500/15 text-[11px] font-bold text-relay-600">{i + 1}</span>
              <span className="flex-1 text-ink-800 dark:text-ink-100">{label}</span>
              <span className="text-xs text-ink-400">{stop.legKm.toFixed(1)} km</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[11px] text-ink-400">Straight-line distances, nearest stop first; every pickup comes before its drop-off.</p>
    </Card>
  );
}

function ActiveDeliveryCard({ row, location, onAdvanced }: { row: OrderRow; location: { lat: number; lon: number }; onAdvanced: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropoffPhoto, setDropoffPhoto] = useState("");
  // The customer's delivery PIN, read out at the door -- required when the
  // store says so, and the driver's best proof of delivery either way.
  const [pin, setPin] = useState("");

  useLocationBroadcast(row.hash, TRACKED_STATUSES.includes(row.order.status));

  async function advance(action: "en_route" | "pickup" | "await_dropoff") {
    setBusy(true);
    setError(null);
    try {
      if (action === "en_route") {
        await setOrderStatus(row.hash, "DriverEnRouteToMerchant");
      } else if (action === "pickup") {
        await recordLeg({ order_ref: row.hash, sequence: 0, kind: "MerchantHandoff", to: row.order.merchant, geo_at_completion: location });
        await pickUpOrder(row.hash);
      } else if (action === "await_dropoff") {
        if (row.order.pin_required && pin.trim().length !== 6) {
          throw new Error("This store requires the customer's 6-digit PIN. Ask them for it before marking the order delivered.");
        }
        await recordLeg({
          order_ref: row.hash,
          sequence: 1,
          kind: "CustomerHandoff",
          to: row.order.requester,
          geo_at_completion: location,
          photo_data_uri: dropoffPhoto,
          pin: pin.trim() || null,
        });
      }
      await onAdvanced();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-2 border-relay-400 p-4">
      <OrderStatusTimeline status={row.order.status} />
      {row.order.ready_by !== null && (row.order.status === "BidAccepted" || row.order.status === "MerchantConfirmed" || row.order.status === "DriverEnRouteToMerchant") && (
        <p className="mt-2 text-xs text-ink-500">Food ready at the store by {formatClockTime(row.order.ready_by)}.</p>
      )}
      {row.dropoff?.recipient && <p className="mt-2 text-sm font-semibold text-ink-900 dark:text-ink-50">Deliver to {row.dropoff.recipient}</p>}
      <p className="mt-2 text-xs font-semibold text-relay-600">Drop-off: {DROPOFF_PREFERENCE_LABEL[row.order.dropoff_preference]}</p>
      {row.dropoff?.notes && (
        <p className="mt-3 rounded-lg bg-ink-100/60 dark:bg-ink-800/60 p-2.5 text-xs text-ink-500">
          <span className="font-semibold text-ink-900 dark:text-ink-50">Drop-off notes: </span>
          {row.dropoff.notes}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-ink-400">Delivery fee</span>
          <span className="text-ink-900 dark:text-ink-50">{formatCents(row.bid?.price_offer ?? 0)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-ink-400">Tip</span>
          <span className="text-ink-900 dark:text-ink-50">{formatCents(row.order.tip_cents)}</span>
        </div>
        <div className="flex items-center justify-between border-t border-ink-100 dark:border-ink-800 pt-2 mt-1">
          <span className="text-ink-400">Total payout</span>
          <StatNumber tone="success" className="text-lg">{formatCents((row.bid?.price_offer ?? 0) + row.order.tip_cents)}</StatNumber>
        </div>
      </div>
      <div className="mt-4">
        {row.order.status === "MerchantConfirmed" && (
          <Button className="w-full" loading={busy} onClick={() => advance("en_route")}>
            Head to merchant
          </Button>
        )}
        {row.order.status === "DriverEnRouteToMerchant" && (
          <Button className="w-full" loading={busy} onClick={() => advance("pickup")}>
            Confirm pickup from merchant
          </Button>
        )}
        {row.order.status === "PickedUp" && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs text-ink-400">Optional: photo at drop-off, for the customer's reassurance.</p>
            <PhotoInput value={dropoffPhoto} onChange={setDropoffPhoto} shape="banner" className="w-full" />
            <label className="mt-2 block text-xs font-semibold text-ink-500">
              {row.order.pin_required ? "Customer's delivery PIN (required)" : "Customer's delivery PIN (recommended)"}
            </label>
            <input
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              placeholder="6 digits"
              className="mt-1 w-full rounded-xl border border-ink-200 px-3 py-2 text-sm dark:border-ink-700 dark:bg-ink-900"
            />
            <Button className="w-full" loading={busy} onClick={() => advance("await_dropoff")}>
              Confirm handoff to customer
            </Button>
          </div>
        )}
        {row.order.status === "BidAccepted" && <p className="text-center text-xs text-ink-400">Waiting for the merchant to confirm prep…</p>}
      </div>
      <div className="mt-4">
        <ChatPanel orderRef={row.hash} title="Chat with customer" />
      </div>
      {error && <p className="mt-3 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </Card>
  );
}

function BidCard({
  order,
  loading,
  onBid,
  sameMerchant,
  nearbyDropoffKm,
}: {
  order: DeliveryOrder;
  loading: boolean;
  onBid: (etaMinutes: number, feeCents: number) => void;
  sameMerchant?: boolean;
  nearbyDropoffKm?: number | null;
}) {
  const [eta, setEta] = useState(15);
  const [fee, setFee] = useState(500);
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="flex items-baseline gap-1 text-sm font-bold text-ink-900 dark:text-ink-50">
          <StatNumber className="text-base">{formatCents(order.order_total)}</StatNumber> order
        </p>
        <span className="text-xs text-ink-400">{formatEta(eta * 60)}</span>
      </div>
      {sameMerchant ? (
        <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-relay-600">
          <Link2 size={12} /> Same restaurant as your current pickup
        </p>
      ) : (
        nearbyDropoffKm !== null &&
        nearbyDropoffKm !== undefined &&
        nearbyDropoffKm < 2 && (
          <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-presence-600">
            <Link2 size={12} /> {nearbyDropoffKm < 0.1 ? "Same drop-off area" : `${nearbyDropoffKm.toFixed(1)}km from your other drop-off`}
          </p>
        )
      )}
      <p className="mt-1 text-xs text-ink-400">
        {itemCount(order)} item{itemCount(order) === 1 ? "" : "s"}
        {order.ready_by !== null && <span> · ready {formatClockTime(order.ready_by)}</span>}
        {order.tip_cents > 0 && <span className="font-semibold text-presence-600"> · {formatCents(order.tip_cents)} tip</span>}
      </p>
      <CustomerHistory customer={order.requester} pinRequired={order.pin_required} />
      {/* The bid commits it; validation requires it at pickup. */}
      <p className="mt-1 flex items-center gap-1 text-xs text-ink-400">
        <ShieldCheck size={12} /> You'll set aside {formatCents(order.order_total)} collateral from pickup until delivery.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <label className="flex-1 text-xs text-ink-400">
          ETA (min)
          <Input type="number" min={1} value={eta} onChange={(e) => setEta(Number(e.target.value))} className="mt-1 py-1.5 text-sm" />
        </label>
        <label className="flex-1 text-xs text-ink-400">
          Your fee
          <Input
            type="number"
            min={0}
            step={0.5}
            value={fee / 100}
            onChange={(e) => setFee(Math.round(Number(e.target.value) * 100))}
            prefix="$"
            className="mt-1 py-1.5 text-sm"
          />
        </label>
        <Button className="mt-4 px-4 py-2 text-xs" loading={loading} onClick={() => onBid(eta, fee)}>
          Bid
        </Button>
      </div>
    </Card>
  );
}
