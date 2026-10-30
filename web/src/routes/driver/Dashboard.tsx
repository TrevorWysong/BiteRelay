import { useEffect, useRef, useState } from "react";
import { Bike, Link2, MapPin, Power, Route, ShieldCheck, Zap } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { getOpenOrdersNear, submitBid, withdrawBid, getMyActiveDeliveries, getOrderPrivateDetails, dropOrder, commitToOrder } from "../../holochain/zomes/dispatch";
import { sendLocationUpdate } from "../../holochain/live";
import { Sheet } from "../../components/Sheet";
import { decodeEntry, actionHash, bytesToHex, bytesEqual, hexToBytes } from "../../holochain/decode";
import { getCatalog } from "../../holochain/zomes/catalog";
import { planRoute } from "../../lib/driving/route";
import { itemCount } from "../../lib/orders/orderEntries";
import { myAgentPubKey } from "../../holochain/client";
import { encodeGeohash, distanceKm, geohashCenter } from "../../lib/places/geohash";
import { useSession } from "../../store/session";
import { Button, Card, EmptyState, Input, PresenceDot, Skeleton, StatNumber } from "../../components/ui";
import { OrderStatusTimeline } from "../../components/OrderStatus";
import { StarRating } from "../../components/StarRating";
import { ChatPanel } from "../../components/ChatPanel";
import { HandoffStep } from "./HandoffStep";
import { StoreCheckIn, StorePickup } from "./AtTheStore";
import { averageRating, getRatingSummary, getReputationSummary } from "../../holochain/zomes/reputation";
import { formatCents, formatDistance, formatEta, formatClockTime, toMinorUnits, fromMinorUnits, currencySymbol } from "../../lib/ui/format";
import { useT, type MessageKey } from "../../i18n";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { describeError } from "../../lib/ui/errors";
import { useLocalSignal, useResource } from "../../lib/hooks/useResource";
import { CustomerHistory } from "../../components/CustomerHistory";
import type { Bid, DeliveryOrder, DeliveryStatus, DropoffDetails, GeoPoint, MerchantCatalog } from "../../holochain/types";
import { POLL, isOrderSignal } from "../../lib/network/poll";
import { offerable, offerRefusal, offerRules, type Commitment } from "../../lib/driving/addOns";
import { estimateTrip } from "../../lib/driving/eta";
import { autoBidPrice, skipsStore } from "../../lib/driving/autoBid";
import { currentBeacon } from "../../lib/network/timeSource";
import { useClock } from "../../lib/hooks/useClock";
import { useDriverSettings } from "../../store/roleSettings";
import { DriverSettingsCard } from "./DriverSettingsCard";
import { VerificationCard } from "./VerificationCard";
import { useTerms } from "../../store/network";
import { useSentBids, type SentBid } from "../../store/sentBids";

const DROPOFF_PREFERENCE_LABEL: Record<DeliveryOrder["dropoff_preference"], MessageKey> = {
  LeaveAtDoor: "cart.drop.leaveAtDoor",
  HandToMe: "cart.drop.handToMe",
  MeetOutside: "cart.drop.meetOutside",
};

// Live location is only meaningful once the driver has committed and is
// moving on this delivery. Every 8s: a few seconds, not sub-second -- fast
// enough to feel live, far below anything that would stress signal
// delivery the way a tighter interval could.
const TRACKED_STATUSES: DeliveryStatus[] = ["DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore", "PickedUp"];
/// Before the driver has the food -- when they can still drop a delivery.
const BEFORE_PICKUP: DeliveryStatus[] = ["BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore"];
/// On the way to the store, not yet checked in.
const ON_THE_WAY: DeliveryStatus[] = ["DriverEnRouteToMerchant", "MerchantConfirmed"];

/// Orders this device has bid on automatically, so a poll never bids twice
/// (the network refuses a second bid regardless).
const autoBidOn = new Set<string>();
const LOCATION_BROADCAST_MS = 8000;

/// Browser geolocation, throttled client-side (nothing on the network can
/// rate-limit a direct signal -- see holochain/live.ts) and silently inert
/// if the API is unavailable or the user denies permission. Named, not hidden: a driver who never grants
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


export function DriverDashboard() {
  const location = useSession((s) => s.location);
  const t = useT();
  const me = useSession((s) => s.agentPubKey);
  const driverKey = myAgentPubKey();
  const driverHex = bytesToHex(driverKey);
  const sentBids = useSentBids((s) => s.sent);
  useLocalSignal((signal) => {
    if ("BidReleased" in signal) useSentBids.getState().forgetBid(bytesToHex(signal.BidReleased));
  });
  const [online, setOnline] = useState(false);
  const [bidding, setBidding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Driver ratings only -- if this agent also runs a store, that store's
  // reviews live on the store, never here.
  const { data: rating } = useResource(`driver-rating:${driverHex}`, () => getRatingSummary({ Driver: driverKey }));
  const avgRating = rating ? averageRating(rating) : null;

  const terms = useTerms();
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

  /// Bids on each newly offered order the driver's rule takes, at their
  /// rate -- skipping stores other drivers keep reporting.
  async function bidAutomatically(offered: OrderRow[]) {
    const { autoBid, limits, travelSpeedKmh } = useDriverSettings.getState();
    if (!autoBid.on) return;
    const commitmentsNow: Commitment[] = activeOrders.map((row) => ({ order: row.order, dropoff: dropoffPoint(row) }));
    for (const { hash: orderRef, order } of offerable(offered, commitmentsNow, offerRules(terms, limits))) {
      const key = bytesToHex(orderRef);
      if (autoBidOn.has(key)) continue;
      autoBidOn.add(key);
      try {
        const [catalog, store] = await Promise.all([getCatalog(order.catalog_ref), getReputationSummary({ Store: order.catalog_ref })]);
        if (skipsStore(store.check_in_refused_count, autoBid)) continue;
        const storeAt = decodeEntry<MerchantCatalog>(catalog).location;
        const dropoffAt = geohashCenter(order.dropoff_geohash);
        const price = autoBidPrice(distanceKm(location, storeAt) + distanceKm(storeAt, dropoffAt), order.max_delivery_fee, { rule: autoBid, minFeeCents: limits.minFeeCents });
        if (price === null) continue;
        const trip = estimateTrip({ from: location, store: storeAt, dropoff: dropoffAt, speedKmh: travelSpeedKmh, readyBy: order.ready_by, prepMinutes: order.prep_minutes, nowMs: Date.now() });
        await sendBid(driverHex, orderRef, trip, price);
      } catch {
        // Already bid, or the order moved on: nothing to do.
      }
    }
  }

  // Open orders near the driver -- only read while online. With "bid for
  // me" on, each newly offered one is bid on as it's read.
  const { data: nearby } = useResource(
    online ? `driver-nearby:${geohash}` : null,
    async (): Promise<OrderRow[]> => {
      const rows = (await getOpenOrdersNear(geohash)).map((r) => ({ hash: actionHash(r), order: decodeEntry<DeliveryOrder>(r) }));
      // A requester/merchant can't deliver their own order (validate_new_bid
      // rejects it) -- hidden here so they never see a Bid button for one.
      const offered = rows.filter(({ order }) => !bytesEqual(order.requester, driverKey) && !bytesEqual(order.merchant, driverKey));
      await bidAutomatically(offered);
      return offered;
    },
    // Drivers find orders by looking, never by announcing where they are
    // (see dispatch `matching`) -- so while online, look often, and keep
    // looking in the background so a new order still rings.
    { pollMs: POLL.driverFeed, background: true },
  );

  function toggleOnline() {
    setOnline(!online);
  }

  async function placeBid(orderRef: Uint8Array, trip: { etaMinutes: number; toStoreMinutes: number }, feeCents: number) {
    setBidding(bytesToHex(orderRef));
    setError(null);
    try {
      await sendBid(driverHex, orderRef, trip, feeCents);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBidding(null);
    }
  }

  /// Takes back the offer this device sent on an order.
  async function withdraw(orderRef: Uint8Array) {
    const orderHex = bytesToHex(orderRef);
    const offer = sentBids[`${driverHex}:${orderHex}`];
    if (!offer) return;
    setBidding(orderHex);
    setError(null);
    try {
      await withdrawBid(hexToBytes(offer.bid));
      useSentBids.getState().forget(driverHex, orderHex);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBidding(null);
    }
  }

  // Order batching -- a client-side
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
  // What this driver has taken on decides what they're offered: add-ons on
  // their way while they're delivering, nothing past their limit.
  const ownLimits = useDriverSettings((s) => s.limits);
  const rules = offerRules(terms, ownLimits);
  const commitments: Commitment[] = activeOrders.map((row) => ({ order: row.order, dropoff: dropoffPoint(row) }));
  const refusal = offerRefusal(commitments, rules);
  const sortedNearby = online && nearby
    ? offerable(nearby, commitments, rules).sort((a, b) => {
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
            {online ? t("drive.online") : t("drive.offline")}
          </p>
          <p className="text-xs text-ink-400">{online ? t("drive.onlineDetail") : t("drive.offlineDetail")}</p>
          {avgRating !== null && rating && <StarRating value={avgRating} count={rating.count} size={11} />}
        </div>
        <motion.button
          onClick={toggleOnline}
          aria-label={online ? t("drive.goOffline") : t("drive.goOnline")}
          whileTap={{ scale: 0.92 }}
          animate={{ backgroundColor: online ? "#22c55e" : "#ece9e6" }}
          transition={{ duration: 0.25 }}
          className={`grid h-11 w-11 place-items-center rounded-full ${online ? "text-white shadow-[var(--shadow-glow)]" : "text-ink-400"}`}
          style={online ? { boxShadow: "0 6px 20px -4px rgba(34, 197, 94, 0.5)" } : undefined}
        >
          <Power size={20} />
        </motion.button>
      </Card>

      {me && <VerificationCard me={me} />}
      <DriverSettingsCard />

      <AnimatePresence initial={false}>
        {activeOrders.length > 0 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mb-5 flex flex-col gap-4">
            <p className="text-xs font-bold uppercase tracking-wide text-relay-600">
              {t("drive.active", { count: activeOrders.length })}
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

      {online && refusal === null && (
        <>
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-ink-400">
            <MapPin size={14} className="text-relay-500" />
            {activeOrders.length === 0 ? t("drive.nearby") : t("drive.addOns")}
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
          {sortedNearby?.length === 0 &&
            (activeOrders.length === 0 ? (
              <EmptyState icon={<Bike size={28} />} title={t("drive.noneNearby")} subtitle={t("drive.noneNearbyDetail")} />
            ) : (
              <EmptyState icon={<Route size={28} />} title={t("drive.noAddOns")} subtitle={t("drive.noAddOnsDetail")} />
            ))}
          <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="flex flex-col gap-3">
            {sortedNearby?.map(({ hash, order }) => (
              <motion.div key={bytesToHex(hash)} variants={fadeSlideUp} layout>
                <BidCard
                  order={order}
                  loading={bidding === bytesToHex(hash)}
                  sent={sentBids[`${driverHex}:${bytesToHex(hash)}`]}
                  onBid={(trip, fee) => placeBid(hash, trip, fee)}
                  onWithdraw={() => withdraw(hash)}
                  sameMerchant={sameMerchantHexes.has(bytesToHex(order.catalog_ref))}
                  nearbyDropoffKm={nearestActiveDropoffKm(order)}
                  detourKm={rules.detourKm}
                  location={location}
                />
              </motion.div>
            ))}
          </motion.div>
        </>
      )}

      {online && refusal !== null && (
        <p className="rounded-xl bg-ink-100/60 dark:bg-ink-800/60 px-4 py-3 text-center text-xs text-ink-400">
          {refusal === "CarryingPriority" ? t("drive.onPriority") : t("drive.atLimit", { count: rules.maxAtOnce })}
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
  const t = useT();
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
        <Route size={13} /> {t("drive.route")}
      </p>
      <ol className="flex flex-col gap-1.5">
        {stops.map((stop, i) => {
          const order = byHex.get(stop.id)!.order;
          const label = stop.kind === "pickup" ? t("drive.pickUpAt", { store: stores[bytesToHex(order.catalog_ref)]?.name ?? t("order.theStore") }) : t("drive.dropOffAs", { how: t(DROPOFF_PREFERENCE_LABEL[order.dropoff_preference]) });
          return (
            <li key={`${stop.id}-${stop.kind}`} className="flex items-center gap-2 text-sm">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-relay-500/15 text-[11px] font-bold text-relay-600">{i + 1}</span>
              <span className="flex-1 text-ink-800 dark:text-ink-100">{label}</span>
              <span className="text-xs text-ink-400">{formatDistance(stop.legKm)}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[11px] text-ink-400">{t("drive.routeNote")}</p>
    </Card>
  );
}

function ActiveDeliveryCard({ row, location, onAdvanced }: { row: OrderRow; location: { lat: number; lon: number }; onAdvanced: () => Promise<void> }) {
  const terms = useTerms();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  useLocationBroadcast(row.hash, TRACKED_STATUSES.includes(row.order.status));
  // A driver leaving an order the store has started cooking answers for the
  // food until another driver takes it on.
  const cooking = row.order.ready_by !== null;

  async function run(step: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await step();
      await onAdvanced();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const drop = () =>
    run(async () => {
      await dropOrder(row.hash, await currentBeacon());
      setDropping(false);
    });
  const commit = () => run(() => commitToOrder(row.hash));

  return (
    <Card className="border-2 border-relay-400 p-4">
      <OrderStatusTimeline status={row.order.status} />
      {row.order.ready_by !== null && BEFORE_PICKUP.includes(row.order.status) && <p className="mt-2 text-xs text-ink-500">{t("drive.readyBy", { time: formatClockTime(row.order.ready_by) })}</p>}
      {row.dropoff?.recipient && <p className="mt-2 text-sm font-semibold text-ink-900 dark:text-ink-50">{t("drive.deliverTo", { name: row.dropoff.recipient })}</p>}
      {!row.dropoff && row.order.status === "BidAccepted" && <p className="mt-2 text-xs text-ink-400">{t("drive.addressAfterCommit")}</p>}
      <p className="mt-2 text-xs font-semibold text-relay-600">{t("order.dropoffLabel")} {t(DROPOFF_PREFERENCE_LABEL[row.order.dropoff_preference])}</p>
      {row.dropoff?.notes && (
        <p className="mt-3 rounded-lg bg-ink-100/60 dark:bg-ink-800/60 p-2.5 text-xs text-ink-500">
          <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.dropoffNotesLabel")} </span>
          {row.dropoff.notes}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-ink-400">{t("cart.deliveryFee")}</span>
          <span className="text-ink-900 dark:text-ink-50">{formatCents(row.bid?.price_offer ?? 0)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-ink-400">{t("cart.tip")}</span>
          <span className="text-ink-900 dark:text-ink-50">{formatCents(row.order.tip_cents)}</span>
        </div>
        <div className="flex items-center justify-between border-t border-ink-100 dark:border-ink-800 pt-2 mt-1">
          <span className="text-ink-400">{t("drive.totalPayout")}</span>
          <StatNumber tone="success" className="text-lg">{formatCents((row.bid?.price_offer ?? 0) + row.order.tip_cents)}</StatNumber>
        </div>
      </div>
      <div className="mt-4">
        {row.order.status === "BidAccepted" && (
          <div className="flex flex-col gap-2">
            <p className="text-center text-xs text-ink-400">{t("drive.committing", { amount: formatCents(row.order.order_total) })}</p>
            <Button variant="secondary" className="w-full" loading={busy} onClick={commit}>
              {t("drive.commitNow")}
            </Button>
          </div>
        )}
        {ON_THE_WAY.includes(row.order.status) && <StoreCheckIn orderRef={row.hash} order={row.order} location={location} onDone={onAdvanced} />}
        {row.order.status === "DriverAtStore" && <StorePickup orderRef={row.hash} order={row.order} location={location} onDone={onAdvanced} />}
        {(row.order.status === "PickedUp" || row.order.status === "Disputed") && <HandoffStep orderRef={row.hash} order={row.order} location={location} onDone={onAdvanced} />}
      </div>
      <div className="mt-4">
        <ChatPanel orderRef={row.hash} title={t("drive.chat")} />
      </div>
      {BEFORE_PICKUP.includes(row.order.status) && (
        <button onClick={() => setDropping(true)} className="mt-3 w-full text-center text-xs font-medium text-ink-400 hover:text-ink-600">
          {t("drive.cantMakeIt")}
        </button>
      )}
      {error && <p className="mt-3 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
      <Sheet
        open={dropping}
        onClose={() => setDropping(false)}
        title={t("drive.dropTitle")}
        subtitle={t("drive.dropSubtitle")}
        footer={
          <Button variant="danger" loading={busy} onClick={drop} className="w-full">
            {t("drive.dropIt")}
          </Button>
        }
      >
        {cooking ? (
          <p className="text-sm leading-relaxed text-ink-500">
            {t("drive.dropCooking", { minutes: Math.round(terms.replacement_window_secs / 60), amount: formatCents(row.order.order_total) })}
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-ink-500">{t("drive.dropNotCooking")}</p>
        )}
      </Sheet>
    </Card>
  );
}

/// Sends an offer on an order, and remembers it on this device.
async function sendBid(driverHex: string, orderRef: Uint8Array, trip: { etaMinutes: number; toStoreMinutes: number }, feeCents: number) {
  const record = await submitBid({
    order_ref: orderRef,
    eta_seconds: trip.etaMinutes * 60,
    to_store_seconds: Math.min(trip.toStoreMinutes, trip.etaMinutes) * 60,
    price_offer: feeCents,
  });
  useSentBids.getState().record(driverHex, bytesToHex(orderRef), { bid: bytesToHex(actionHash(record)), feeCents, etaMinutes: trip.etaMinutes, sentAt: Date.now() });
}

function BidCard({
  order,
  loading,
  sent,
  onBid,
  onWithdraw,
  sameMerchant,
  nearbyDropoffKm,
  detourKm,
  location,
}: {
  order: DeliveryOrder;
  loading: boolean;
  /// The offer this device already sent on it, if any.
  sent?: SentBid;
  onBid: (trip: { etaMinutes: number; toStoreMinutes: number }, feeCents: number) => void;
  onWithdraw: () => void;
  sameMerchant?: boolean;
  nearbyDropoffKm?: number | null;
  /// How near another drop-off counts as on the way (the network's add-on detour).
  detourKm: number;
  /// Where the driver is, for the ETA estimate.
  location: GeoPoint;
}) {
  // The ETA starts as an estimate -- there, waiting for the kitchen if need
  // be, then on to the drop-off at the driver's usual speed -- until they
  // type their own.
  const speedKmh = useDriverSettings((s) => s.travelSpeedKmh);
  const t = useT();
  const storeHex = bytesToHex(order.catalog_ref);
  const { data: storeAt = null } = useResource(`store-location:${storeHex}`, async () => decodeEntry<MerchantCatalog>(await getCatalog(order.catalog_ref)).location);
  const now = useClock(30_000);
  const estimate = storeAt && estimateTrip({ from: location, store: storeAt, dropoff: geohashCenter(order.dropoff_geohash), speedKmh, readyBy: order.ready_by, prepMinutes: order.prep_minutes, nowMs: now.getTime() });
  const [typedEta, setEta] = useState<number | null>(null);
  const eta = typedEta ?? estimate?.etaMinutes ?? null;
  // How the store treats drivers: kept them waiting, or refused to check
  // them in -- other drivers' records of it.
  const { data: store = null } = useResource(`store-record:${storeHex}`, () => getReputationSummary({ Store: order.catalog_ref }));
  // The customer's cap, which no bid may exceed -- the driver lowers it to compete.
  const [fee, setFee] = useState(order.max_delivery_fee ?? 0);
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="flex items-baseline gap-1 text-sm font-bold text-ink-900 dark:text-ink-50">
          {t("order.heading")}<StatNumber className="text-base">{formatCents(order.order_total)}</StatNumber>
        </p>
        {eta !== null && <span className="text-xs text-ink-400">{formatEta(eta * 60)}</span>}
      </div>
      {sameMerchant ? (
        <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-relay-600">
          <Link2 size={12} /> {t("drive.sameStore")}
        </p>
      ) : (
        nearbyDropoffKm !== null &&
        nearbyDropoffKm !== undefined &&
        nearbyDropoffKm <= detourKm && (
          <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-presence-600">
            <Link2 size={12} /> {nearbyDropoffKm < 0.1 ? t("drive.sameArea") : t("drive.nearOther", { distance: formatDistance(nearbyDropoffKm) })}
          </p>
        )
      )}
      <p className="mt-1 text-xs text-ink-400">
        {t("orders.items", { count: itemCount(order) })}
        {order.ready_by !== null && <span> · {t("drive.ready", { time: formatClockTime(order.ready_by) })}</span>}
        {order.tip_cents > 0 && <span className="font-semibold text-presence-600"> · {t("drive.tipAmount", { amount: formatCents(order.tip_cents) })}</span>}
      </p>
      {order.priority && (
        <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-amber-600">
          <Zap size={12} /> {t("drive.priority")}
        </p>
      )}
      <CustomerHistory customer={order.requester} />
      {store && (store.late_count > 0 || store.check_in_refused_count > 0) && (
        <p className="mt-1 text-xs font-semibold text-amber-600">
          {t("drive.storeRecord", { late: store.late_count, refused: store.check_in_refused_count })}
        </p>
      )}
      {/* Validation requires it when they commit. */}
      <p className="mt-1 flex items-center gap-1 text-xs text-ink-400">
        <ShieldCheck size={12} /> {t("drive.collateral", { amount: formatCents(order.order_total) })}
      </p>
      {sent ? (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-relay-50 px-3 py-2 dark:bg-relay-900/30">
          <p className="text-xs font-semibold text-relay-700 dark:text-relay-300">{t("drive.offerSent", { fee: formatCents(sent.feeCents), eta: formatEta(sent.etaMinutes * 60) })}</p>
          <Button variant="ghost" className="px-3 py-1.5 text-xs" loading={loading} onClick={onWithdraw}>
            {t("drive.withdraw")}
          </Button>
        </div>
      ) : (
      <div className="mt-3 flex items-center gap-2">
        <label className="flex-1 text-xs text-ink-400">
          {t("drive.eta")}
          <Input type="number" min={1} value={eta ?? ""} onChange={(e) => setEta(Math.max(1, Math.round(Number(e.target.value))))} className="mt-1 py-1.5 text-sm" />
        </label>
        <label className="flex-1 text-xs text-ink-400">
          {t("drive.yourFee")}
          <Input
            type="number"
            min={0}
            step={0.5}
            value={fromMinorUnits(fee)}
            onChange={(e) => setFee(toMinorUnits(Number(e.target.value)))}
            prefix={currencySymbol()}
            className="mt-1 py-1.5 text-sm"
          />
        </label>
        <Button className="mt-4 px-4 py-2 text-xs" loading={loading} disabled={eta === null} onClick={() => eta !== null && onBid({ etaMinutes: eta, toStoreMinutes: Math.min(estimate?.toStoreMinutes ?? eta, eta) }, fee)}>
          {t("drive.bid")}
        </Button>
      </div>
      )}
    </Card>
  );
}
