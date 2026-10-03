import { useCallback, useEffect, useRef, useState } from "react";
import { Bike, Link2, MapPin, Power } from "lucide-react";
import { announceOnline, announceOffline, PRESENCE_REFRESH_MS } from "../../holochain/zomes/geoPresence";
import { getOpenOrdersNear, submitBid, getOrder, setOrderStatus, listMyBids, sendLocationUpdate } from "../../holochain/zomes/dispatch";
import { recordLeg, initiateLegAttestation } from "../../holochain/zomes/attestation";
import { decodeEntry, actionHash, bytesToHex, bytesEqual } from "../../holochain/decode";
import { onLocalSignal, myAgentPubKey } from "../../holochain/client";
import { encodeGeohash, distanceKm } from "../../lib/geohash";
import { useSession } from "../../store/session";
import { Button, Card, EmptyState, PresenceDot, Spinner } from "../../components/ui";
import { OrderStatusTimeline } from "../../components/OrderStatus";
import { StarRating } from "../../components/StarRating";
import { ChatPanel } from "../../components/ChatPanel";
import { PhotoInput } from "../../components/PhotoInput";
import { getReviewsFor } from "../../holochain/zomes/reputation";
import { formatCents, formatEta } from "../../lib/format";
import type { Bid, DeliveryOrder, DeliveryStatus, Review } from "../../holochain/types";

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
  hash: Uint8Array;
  order: DeliveryOrder;
  bid?: Bid;
}

const POLL_MS = 8000;
// Nothing in the backend caps concurrent deliveries per driver -- checked
// directly: `accept_bid`/`validate_new_bid` never require the bidder be
// otherwise free, and `get_nearby_providers`/`get_open_orders_near` never
// exclude an already-busy driver. The gap named in the architecture plan's
// §7 ("offer an active driver a 3rd delivery on their route") was entirely
// client-side: this dashboard used to track and render only the *first*
// active order it found. This constant is a deliberate, modest, named cap
// -- not real route optimization (still a genuine v2 gap, unaddressed) --
// just enough to let a driver already on one or two deliveries pick up
// another that's genuinely on their way, without overcommitting past what
// one person can reasonably carry at once.
const MAX_CONCURRENT_DELIVERIES = 3;

export function DriverDashboard() {
  const location = useSession((s) => s.location);
  const driverKey = myAgentPubKey();
  const [online, setOnline] = useState(false);
  const [nearby, setNearby] = useState<OrderRow[] | null>(null);
  const [activeOrders, setActiveOrders] = useState<OrderRow[]>([]);
  const [bidding, setBidding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);

  useEffect(() => {
    getReviewsFor(driverKey).then((records) => setReviews(records.map((r) => decodeEntry<Review>(r))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const avgRating = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;

  const geohash = encodeGeohash(location.lat, location.lon);

  const refreshNearby = useCallback(async () => {
    const records = await getOpenOrdersNear(geohash);
    const rows = records.map((r) => ({ hash: actionHash(r), order: decodeEntry<DeliveryOrder>(r) }));
    // A requester/merchant can't legally deliver their own order (enforced
    // network-wide in dispatch_integrity's validate_new_bid) -- filtered
    // here too so this agent never sees a "Bid" button on it in the first
    // place, rather than discovering the rejection only after tapping Bid.
    setNearby(rows.filter(({ order }) => !bytesEqual(order.requester, driverKey) && !bytesEqual(order.merchant, driverKey)));
  }, [geohash, driverKey]);

  // "Which orders am I currently delivering" has no dedicated backend read --
  // it's derived from two real ones: `list_my_bids` (this driver's own
  // authored Bid entries, a purely local source-chain query, no gossip
  // needed) crossed against each referenced order's current `accepted_bid`,
  // collecting *every* bid of theirs that won and hasn't finished yet (not
  // just the first) -- a driver can legitimately be delivering more than
  // one order at once, see `MAX_CONCURRENT_DELIVERIES` above.
  const refreshActiveOrders = useCallback(async () => {
    const bidRecords = await listMyBids();
    const rows: OrderRow[] = [];
    for (const bidRecord of bidRecords) {
      const bid = decodeEntry<Bid>(bidRecord);
      try {
        const orderRecord = await getOrder(bid.order_ref);
        const order = decodeEntry<DeliveryOrder>(orderRecord);
        const isMine = order.accepted_bid && bytesEqual(order.accepted_bid, actionHash(bidRecord));
        if (isMine && !["Delivered", "Cancelled"].includes(order.status)) {
          rows.push({ hash: actionHash(orderRecord), order, bid });
        }
      } catch {
        // order not found / not readable yet -- skip
      }
    }
    setActiveOrders(rows);
  }, []);

  useEffect(() => {
    refreshActiveOrders();
    const interval = setInterval(refreshActiveOrders, POLL_MS);
    const unsub = onLocalSignal((s) => {
      if ("BidAccepted" in s || "BidReleased" in s) refreshActiveOrders();
    });
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [refreshActiveOrders]);

  useEffect(() => {
    if (!online) {
      setNearby(null);
      return;
    }
    announceOnline(location, ["Food"]).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    refreshNearby();
    const presenceInterval = setInterval(() => announceOnline(location, ["Food"]).catch(() => {}), PRESENCE_REFRESH_MS);
    const pollInterval = setInterval(refreshNearby, POLL_MS);
    const unsub = onLocalSignal((s) => {
      if ("NewOrderNearby" in s) refreshNearby();
    });
    return () => {
      clearInterval(presenceInterval);
      clearInterval(pollInterval);
      unsub();
    };
  }, [online, location, refreshNearby]);

  async function toggleOnline() {
    if (online) {
      await announceOffline().catch(() => {});
      setOnline(false);
    } else {
      setOnline(true);
    }
  }

  async function placeBid(orderRef: Uint8Array, etaMinutes: number, feeCents: number) {
    setBidding(bytesToHex(orderRef));
    setError(null);
    try {
      await submitBid({
        order_ref: orderRef,
        eta_seconds: etaMinutes * 60,
        price_offer: feeCents,
        collateral_commitment: { account: bytesToHex(driverKey), amount: 100, ledger_txn_ref: "pending" },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
  function nearestActiveDropoffKm(order: DeliveryOrder): number | null {
    if (activeOrders.length === 0) return null;
    return Math.min(...activeOrders.map((a) => distanceKm(order.dropoff, a.order.dropoff)));
  }
  const sortedNearby = nearby
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
          {reviews.length > 0 && <StarRating value={avgRating} count={reviews.length} size={11} />}
        </div>
        <button
          onClick={toggleOnline}
          className={`grid h-11 w-11 place-items-center rounded-full transition ${online ? "bg-presence-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-400"}`}
        >
          <Power size={20} />
        </button>
      </Card>

      {activeOrders.length > 0 && (
        <div className="mb-5 flex flex-col gap-4">
          <p className="text-xs font-bold uppercase tracking-wide text-relay-600">
            Active {activeOrders.length === 1 ? "delivery" : `deliveries (${activeOrders.length})`}
          </p>
          {activeOrders.map((row) => (
            <ActiveDeliveryCard key={bytesToHex(row.hash)} row={row} location={location} onAdvanced={refreshActiveOrders} />
          ))}
        </div>
      )}

      {online && activeOrders.length < MAX_CONCURRENT_DELIVERIES && (
        <>
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-ink-400">
            <MapPin size={14} className="text-relay-500" />
            Nearby open orders
          </div>
          {sortedNearby === null && (
            <div className="flex justify-center py-10 text-ink-300">
              <Spinner />
            </div>
          )}
          {sortedNearby?.length === 0 && <EmptyState icon={<Bike size={28} />} title="No open orders nearby" subtitle="This refreshes automatically as new orders are placed near you." />}
          <div className="flex flex-col gap-3">
            {sortedNearby?.map(({ hash, order }) => (
              <BidCard
                key={bytesToHex(hash)}
                order={order}
                loading={bidding === bytesToHex(hash)}
                onBid={(eta, fee) => placeBid(hash, eta, fee)}
                sameMerchant={sameMerchantHexes.has(bytesToHex(order.catalog_ref))}
                nearbyDropoffKm={nearestActiveDropoffKm(order)}
              />
            ))}
          </div>
        </>
      )}

      {online && activeOrders.length >= MAX_CONCURRENT_DELIVERIES && (
        <p className="rounded-xl bg-ink-100/60 dark:bg-ink-800/60 px-4 py-3 text-center text-xs text-ink-400">
          You're at your {MAX_CONCURRENT_DELIVERIES}-delivery limit -- finish one to see new nearby orders again.
        </p>
      )}

      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}

function ActiveDeliveryCard({ row, location, onAdvanced }: { row: OrderRow; location: { lat: number; lon: number }; onAdvanced: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropoffPhoto, setDropoffPhoto] = useState("");

  useLocationBroadcast(row.hash, TRACKED_STATUSES.includes(row.order.status));

  async function advance(action: "en_route" | "pickup" | "await_dropoff") {
    setBusy(true);
    setError(null);
    try {
      if (action === "en_route") {
        await setOrderStatus(row.hash, "DriverEnRouteToMerchant");
      } else if (action === "pickup") {
        const legRecord = await recordLeg({ order_ref: row.hash, sequence: 0, kind: "MerchantHandoff", to: row.order.merchant, geo_at_completion: location });
        await initiateLegAttestation(actionHash(legRecord));
        await setOrderStatus(row.hash, "PickedUp");
      } else if (action === "await_dropoff") {
        const legRecord = await recordLeg({
          order_ref: row.hash,
          sequence: 1,
          kind: "CustomerHandoff",
          to: row.order.requester,
          geo_at_completion: location,
          photo_data_uri: dropoffPhoto,
        });
        await initiateLegAttestation(actionHash(legRecord));
      }
      await onAdvanced();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-2 border-relay-400 p-4">
      <OrderStatusTimeline status={row.order.status} />
      <p className="mt-2 text-xs font-semibold text-relay-600">Drop-off: {DROPOFF_PREFERENCE_LABEL[row.order.dropoff_preference]}</p>
      {row.order.special_instructions && (
        <p className="mt-3 rounded-lg bg-ink-100/60 dark:bg-ink-800/60 p-2.5 text-xs text-ink-500">
          <span className="font-semibold text-ink-900 dark:text-ink-50">Notes: </span>
          {row.order.special_instructions}
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
        <div className="flex items-center justify-between border-t border-ink-100 dark:border-ink-800 pt-1 font-bold">
          <span className="text-ink-400">Total payout</span>
          <span className="text-ink-900 dark:text-ink-50">{formatCents((row.bid?.price_offer ?? 0) + row.order.tip_cents)}</span>
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
        <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{formatCents(order.order_total)} order</p>
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
        {order.item_refs.length} item{order.item_refs.length === 1 ? "" : "s"} · dropoff {order.dropoff_geohash}
        {order.tip_cents > 0 && <span className="font-semibold text-presence-600"> · {formatCents(order.tip_cents)} tip</span>}
      </p>
      {order.special_instructions && <p className="mt-1 truncate text-xs text-ink-400">"{order.special_instructions}"</p>}
      <div className="mt-3 flex items-center gap-2">
        <label className="flex-1 text-xs text-ink-400">
          ETA (min)
          <input type="number" min={1} value={eta} onChange={(e) => setEta(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-2 py-1.5 text-sm" />
        </label>
        <label className="flex-1 text-xs text-ink-400">
          Fee ($)
          <input
            type="number"
            min={0}
            step={0.5}
            value={fee / 100}
            onChange={(e) => setFee(Math.round(Number(e.target.value) * 100))}
            className="mt-1 w-full rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-2 py-1.5 text-sm"
          />
        </label>
        <Button className="mt-4 px-4 py-2 text-xs" loading={loading} onClick={() => onBid(eta, fee)}>
          Bid
        </Button>
      </div>
    </Card>
  );
}
