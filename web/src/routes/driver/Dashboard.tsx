import { useCallback, useEffect, useState } from "react";
import { Bike, MapPin, Power } from "lucide-react";
import { announceOnline, announceOffline, PRESENCE_REFRESH_MS } from "../../holochain/zomes/geoPresence";
import { getOpenOrdersNear, submitBid, getOrder, setOrderStatus, listMyBids } from "../../holochain/zomes/dispatch";
import { recordLeg, initiateLegAttestation } from "../../holochain/zomes/attestation";
import { decodeEntry, actionHash, bytesToHex, bytesEqual } from "../../holochain/decode";
import { onLocalSignal, myAgentPubKey } from "../../holochain/client";
import { encodeGeohash } from "../../lib/geohash";
import { useSession } from "../../store/session";
import { Button, Card, EmptyState, PresenceDot, Spinner } from "../../components/ui";
import { OrderStatusTimeline } from "../../components/OrderStatus";
import { StarRating } from "../../components/StarRating";
import { getReviewsFor } from "../../holochain/zomes/reputation";
import { formatCents, formatEta } from "../../lib/format";
import type { Bid, DeliveryOrder, Review } from "../../holochain/types";

interface OrderRow {
  hash: Uint8Array;
  order: DeliveryOrder;
  bid?: Bid;
}

const POLL_MS = 8000;

export function DriverDashboard() {
  const location = useSession((s) => s.location);
  const driverKey = myAgentPubKey();
  const [online, setOnline] = useState(false);
  const [nearby, setNearby] = useState<OrderRow[] | null>(null);
  const [active, setActive] = useState<OrderRow | null>(null);
  const [bidding, setBidding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    setNearby(records.map((r) => ({ hash: actionHash(r), order: decodeEntry<DeliveryOrder>(r) })));
  }, [geohash]);

  // "Which order am I currently delivering" has no dedicated backend read --
  // it's derived from two real ones: `list_my_bids` (this driver's own
  // authored Bid entries, a purely local source-chain query, no gossip
  // needed) crossed against each referenced order's current `accepted_bid`,
  // to find the one bid of theirs that actually won and hasn't finished yet.
  const refreshActive = useCallback(async () => {
    const bidRecords = await listMyBids();
    for (const bidRecord of bidRecords) {
      const bid = decodeEntry<Bid>(bidRecord);
      try {
        const orderRecord = await getOrder(bid.order_ref);
        const order = decodeEntry<DeliveryOrder>(orderRecord);
        const isMine = order.accepted_bid && bytesEqual(order.accepted_bid, actionHash(bidRecord));
        if (isMine && !["Delivered", "Cancelled"].includes(order.status)) {
          setActive({ hash: actionHash(orderRecord), order, bid });
          return;
        }
      } catch {
        // order not found / not readable yet -- skip
      }
    }
    setActive(null);
  }, []);

  useEffect(() => {
    refreshActive();
    const interval = setInterval(refreshActive, POLL_MS);
    const unsub = onLocalSignal((s) => {
      if ("BidAccepted" in s || "BidReleased" in s) refreshActive();
    });
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [refreshActive]);

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

  async function advance(action: "en_route" | "pickup" | "await_dropoff") {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "en_route") {
        await setOrderStatus(active.hash, "DriverEnRouteToMerchant");
      } else if (action === "pickup") {
        const legRecord = await recordLeg({ order_ref: active.hash, sequence: 0, kind: "MerchantHandoff", to: active.order.merchant, geo_at_completion: location });
        await initiateLegAttestation(actionHash(legRecord));
        await setOrderStatus(active.hash, "PickedUp");
      } else if (action === "await_dropoff") {
        const legRecord = await recordLeg({ order_ref: active.hash, sequence: 1, kind: "CustomerHandoff", to: active.order.requester, geo_at_completion: location });
        await initiateLegAttestation(actionHash(legRecord));
      }
      await refreshActive();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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

      {active && (
        <Card className="mb-5 border-2 border-relay-400 p-4">
          <p className="mb-3 text-xs font-bold uppercase tracking-wide text-relay-600">Active delivery</p>
          <OrderStatusTimeline status={active.order.status} />
          {active.order.special_instructions && (
            <p className="mt-3 rounded-lg bg-ink-100/60 dark:bg-ink-800/60 p-2.5 text-xs text-ink-500">
              <span className="font-semibold text-ink-900 dark:text-ink-50">Notes: </span>
              {active.order.special_instructions}
            </p>
          )}
          <div className="mt-4 flex flex-col gap-1 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-ink-400">Delivery fee</span>
              <span className="text-ink-900 dark:text-ink-50">{formatCents(active.bid?.price_offer ?? 0)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-400">Tip</span>
              <span className="text-ink-900 dark:text-ink-50">{formatCents(active.order.tip_cents)}</span>
            </div>
            <div className="flex items-center justify-between border-t border-ink-100 dark:border-ink-800 pt-1 font-bold">
              <span className="text-ink-400">Total payout</span>
              <span className="text-ink-900 dark:text-ink-50">{formatCents((active.bid?.price_offer ?? 0) + active.order.tip_cents)}</span>
            </div>
          </div>
          <div className="mt-4">
            {active.order.status === "MerchantConfirmed" && (
              <Button className="w-full" loading={busy} onClick={() => advance("en_route")}>
                Head to merchant
              </Button>
            )}
            {active.order.status === "DriverEnRouteToMerchant" && (
              <Button className="w-full" loading={busy} onClick={() => advance("pickup")}>
                Confirm pickup from merchant
              </Button>
            )}
            {active.order.status === "PickedUp" && (
              <Button className="w-full" loading={busy} onClick={() => advance("await_dropoff")}>
                Confirm handoff to customer
              </Button>
            )}
            {active.order.status === "BidAccepted" && <p className="text-center text-xs text-ink-400">Waiting for the merchant to confirm prep…</p>}
          </div>
        </Card>
      )}

      {online && !active && (
        <>
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-ink-400">
            <MapPin size={14} className="text-relay-500" />
            Nearby open orders
          </div>
          {nearby === null && (
            <div className="flex justify-center py-10 text-ink-300">
              <Spinner />
            </div>
          )}
          {nearby?.length === 0 && <EmptyState icon={<Bike size={28} />} title="No open orders nearby" subtitle="This refreshes automatically as new orders are placed near you." />}
          <div className="flex flex-col gap-3">
            {nearby?.map(({ hash, order }) => (
              <BidCard key={bytesToHex(hash)} order={order} loading={bidding === bytesToHex(hash)} onBid={(eta, fee) => placeBid(hash, eta, fee)} />
            ))}
          </div>
        </>
      )}

      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}

function BidCard({ order, loading, onBid }: { order: DeliveryOrder; loading: boolean; onBid: (etaMinutes: number, feeCents: number) => void }) {
  const [eta, setEta] = useState(15);
  const [fee, setFee] = useState(500);
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{formatCents(order.order_total)} order</p>
        <span className="text-xs text-ink-400">{formatEta(eta * 60)}</span>
      </div>
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
