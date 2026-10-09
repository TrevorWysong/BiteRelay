import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, Bike, CheckCircle2, ShieldCheck } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cancelOrder, getOrder, getOrderPrivateDetails, listBidsForOrder, acceptBid, raiseDispute, raiseCancellationDispute, completeDelivery, checkWarrants } from "../../holochain/zomes/dispatch";
import { getCatalog } from "../../holochain/zomes/catalog";
import { fetchOrderItemNames } from "../../lib/menu";
import { getLegsForOrder } from "../../holochain/zomes/attestation";
import { averageRating, getMyReviewsForOrder, getRatingSummary, getReputationSummary, submitItemReview, submitReview } from "../../holochain/zomes/reputation";
import { getProfileForAgent } from "../../holochain/zomes/profiles";
import { decodeEntry, actionHash, bytesEqual, bytesToHex, hexToBytes, timestampOf } from "../../holochain/decode";
import { myAgentPubKey, onLocalSignal } from "../../holochain/client";
import { OrderStatusTimeline, StatusBadge } from "../../components/OrderStatus";
import { Button, Card, Skeleton, StatNumber, Textarea } from "../../components/ui";
import { StarRating, StarRatingInput } from "../../components/StarRating";
import { ChatPanel } from "../../components/ChatPanel";
import { LiveMap } from "../../components/LiveMap";
import { WaitingForStore } from "../../components/WaitingForStore";
import { formatCents, formatEta, shortAgentId } from "../../lib/format";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import { describeError } from "../../lib/errors";
import { useResource } from "../../lib/useResource";
import type { Bid, DeliveryOrder, DeliveryStatus, GeoPoint, Leg, LocalSignal, MerchantCatalog, Profile, Review, WarrantSummary } from "../../holochain/types";
import { POLL, isOrderSignal } from "../../lib/poll";

// Chat is only valid once a driver is assigned (send_chat_message requires
// order.accepted_bid to exist) and before the delivery's own terminal state.
const ACTIVE_DELIVERY_STATUSES: DeliveryStatus[] = ["BidAccepted", "MerchantConfirmed", "DriverEnRouteToMerchant", "PickedUp"];

const DROPOFF_PREFERENCE_LABEL: Record<DeliveryOrder["dropoff_preference"], string> = {
  LeaveAtDoor: "Leave at door",
  HandToMe: "Hand to me",
  MeetOutside: "Meet outside",
};

interface DriverStats {
  completedCount: number;
  avgRating: number;
  reviewCount: number;
  displayName: string | null;
}


/// The customer is the one who accepts a bid, so this is the one place
/// that choice should actually be informed by the bidder's track record,
/// not just price/ETA/warrants -- see the architecture plan's discussion
/// of why the restaurant doesn't get a separate veto: shared visibility
/// into the same trust signal covers that interest too. Driver-scoped
/// only: a bidder who also runs a restaurant is judged on their deliveries
/// here, never their store's food. Also resolves a real display name
/// instead of showing the bidder's raw identity hash -- `null` (falling
/// back to `shortAgentId`) just means they haven't set one.
async function fetchDriverStats(agent: Uint8Array): Promise<DriverStats> {
  const [summary, rating, profileRecord] = await Promise.all([
    getReputationSummary({ Driver: agent }),
    getRatingSummary({ Driver: agent }),
    getProfileForAgent(agent),
  ]);
  const displayName = profileRecord ? decodeEntry<Profile>(profileRecord).display_name : null;
  return { completedCount: summary.completed_count, avgRating: averageRating(rating) ?? 0, reviewCount: rating.count, displayName: displayName || null };
}

/// A bid's bidder, with their warrant count and driver track record.
interface BidRow {
  hash: Uint8Array;
  bid: Bid;
  warrants: WarrantSummary | null;
  stats: DriverStats | null;
}

/// Bids arriving or settling, or the order changing.
const ORDER_SIGNALS = (signal: LocalSignal) => "BidPlaced" in signal || "BidAccepted" in signal || "BidReleased" in signal || isOrderSignal(signal);

export function OrderDetail() {
  const { hash = "" } = useParams<{ hash: string }>();
  const orderRef = hexToBytes(hash);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [disputing, setDisputing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merchantRating, setMerchantRating] = useState(0);
  const [merchantComment, setMerchantComment] = useState("");
  const [driverRating, setDriverRating] = useState(0);
  const [driverComment, setDriverComment] = useState("");
  const [itemsRated, setItemsRated] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [driverLocation, setDriverLocation] = useState<GeoPoint | null>(null);
  const [itemRatings, setItemRatings] = useState<Record<string, number>>({});

  // Each read below is keyed by exactly what it depends on, so it's fetched
  // once per value and re-read only when that changes (or while polled).
  // `writtenAt` (when its current version was written) and `now` (when it
  // was read) time the store's window to accept it.
  const { data: snapshot, reload: reloadOrder } = useResource(
    `order:${hash}`,
    async () => {
      const record = await getOrder(orderRef);
      return { order: decodeEntry<DeliveryOrder>(record), writtenAt: timestampOf(record), now: Date.now() };
    },
    { pollMs: POLL.signalled, refreshOn: ORDER_SIGNALS },
  );
  const order = snapshot?.order;
  const storeHex = order ? bytesToHex(order.catalog_ref) : null;
  const { data: pickup = null } = useResource(storeHex && `order-pickup:${storeHex}`, async () => decodeEntry<MerchantCatalog>(await getCatalog(order!.catalog_ref)).location);
  // The exact drop-off and notes are sealed; the zome opens them for us.
  const { data: details } = useResource(`order-details:${hash}`, () => getOrderPrivateDetails(orderRef));
  const { data: itemNames = {} } = useResource(order ? `order-items:${hash}` : null, () => fetchOrderItemNames(order!));
  // The drop-off photo can only appear once the order's picked up; polled
  // until the handoff leg is attested, then read once more on delivery.
  const photoStatus = order && (order.status === "PickedUp" || order.status === "Delivered") ? order.status : null;
  const { data: dropoffPhoto = null } = useResource(
    photoStatus && `order-photo:${hash}:${photoStatus}`,
    async () => {
      const legs = (await getLegsForOrder(orderRef)).map((r) => decodeEntry<Leg>(r));
      return legs.find((leg) => leg.kind === "CustomerHandoff")?.photo_data_uri || null;
    },
    { pollMs: photoStatus === "PickedUp" ? POLL.signalled : undefined, refreshOn: isOrderSignal },
  );
  // What this customer already rated on this order, read back from the
  // conductor rather than kept in memory -- otherwise a reload would offer
  // the rating form again and invite a duplicate.
  const { data: rated, mutate: mutateRated } = useResource(order?.status === "Delivered" ? `order-rated:${hash}` : null, async () => {
    const targets = (await getMyReviewsForOrder(orderRef)).map((r) => decodeEntry<Review>(r).target);
    return { store: targets.some((t) => "Store" in t), driver: targets.some((t) => "Driver" in t) };
  });
  // Bids, while the order is open -- each with its bidder's track record,
  // so accepting one is an informed choice, not just price and ETA.
  const { data: bids = null } = useResource(
    order?.status === "Open" ? `order-bids:${hash}` : null,
    async (): Promise<BidRow[]> => {
      const page = await listBidsForOrder(orderRef);
      return Promise.all(
        page.bids.map(async (record) => {
          const bid = decodeEntry<Bid>(record);
          const [warrants, stats] = await Promise.all([checkWarrants(bid.bidder).catch(() => null), fetchDriverStats(bid.bidder).catch(() => null)]);
          return { hash: actionHash(record), bid, warrants, stats };
        }),
      );
    },
    { pollMs: POLL.signalled, refreshOn: ORDER_SIGNALS },
  );
  // The accepted bid's driver -- found among the order's bids, since bids
  // are only ever read through their order.
  const acceptedHex = order?.accepted_bid ? bytesToHex(order.accepted_bid) : null;
  const { data: driver = null } = useResource(acceptedHex && `order-driver:${acceptedHex}`, async () => {
    const page = await listBidsForOrder(orderRef);
    const won = page.bids.find((record) => bytesToHex(actionHash(record)) === acceptedHex);
    return won ? decodeEntry<Bid>(won).bidder : null;
  });

  async function submitReviews() {
    if (!order || !rated) return;
    setSubmittingReview(true);
    setError(null);
    // Each piece that lands is recorded straight away, so a failure partway
    // through never re-offers (and so never double-submits) what landed.
    try {
      if (merchantRating > 0 && canRateStore) {
        await submitReview({ target: { Store: order.catalog_ref }, order_original_action: orderRef, rating: merchantRating, comment: merchantComment });
        mutateRated((prev) => ({ driver: prev?.driver ?? false, store: true }));
      }
      if (driverRating > 0 && driver && canRateDriver) {
        await submitReview({ target: { Driver: driver }, order_original_action: orderRef, rating: driverRating, comment: driverComment });
        mutateRated((prev) => ({ store: prev?.store ?? false, driver: true }));
      }
      if (canRateItems) {
        for (const [itemHex, rating] of Object.entries(itemRatings)) {
          if (rating > 0) await submitItemReview({ item_ref: hexToBytes(itemHex), order_original_action: orderRef, rating, comment: "" });
        }
        if (Object.values(itemRatings).some((r) => r > 0)) setItemsRated(true);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmittingReview(false);
    }
  }

  // The driver's live position is pushed (signal-only, never stored), not
  // read -- a genuine subscription, so it stays an effect.
  useEffect(() => {
    if (!hash) return;
    const ref = hexToBytes(hash);
    return onLocalSignal((signal) => {
      if ("LocationUpdate" in signal && bytesEqual(signal.LocationUpdate.order_ref, ref)) {
        setDriverLocation({ lat: signal.LocationUpdate.lat, lon: signal.LocationUpdate.lon });
      }
    });
  }, [hash]);

  if (!order) {
    return (
      <div className="flex flex-col gap-3 px-4 pt-4">
        <Skeleton className="h-7 w-2/5" />
        <Card className="p-4">
          <Skeleton className="h-4 w-full mb-3" />
          <Skeleton className="h-4 w-3/4 mb-3" />
          <Skeleton className="h-4 w-1/2" />
        </Card>
        <Card className="p-4">
          <Skeleton className="h-16 w-full" />
        </Card>
      </div>
    );
  }

  async function pickBid(bidHash: Uint8Array) {
    setAccepting(bytesToHex(bidHash));
    setError(null);
    try {
      await acceptBid(orderRef, bidHash);
      await reloadOrder();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setAccepting(null);
    }
  }

  async function fileDispute() {
    setDisputing(true);
    setError(null);
    try {
      if (order!.status === "Cancelled") {
        await raiseCancellationDispute({ order_original_action: orderRef, description: "Requester believes this cancellation was unjust.", evidence_refs: [] });
      } else {
        await raiseDispute({ order_original_action: orderRef, reason: "NeverDelivered", description: "Order never arrived.", evidence_refs: [] });
      }
      await reloadOrder();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setDisputing(false);
    }
  }

  async function confirmReceipt() {
    setCompleting(true);
    setError(null);
    // The two leg attestations are countersigned on the driver's chain and
    // gossip to us from there, not written to our own chain -- so there's a
    // real window right after the driver hands off where the network hasn't
    // caught up yet and this call legitimately isn't satisfiable. Retry a
    // few times with backoff before giving up, rather than surfacing a raw
    // "0 of 2 attestations found" error for something that resolves itself
    // within a few seconds to ~a minute.
    const RETRY_DELAYS_MS = [1500, 3000, 6000, 10000, 15000];
    for (let attempt = 0; ; attempt++) {
      try {
        await completeDelivery(orderRef);
        await reloadOrder();
        break;
      } catch (err) {
        const message = describeError(err);
        const isGossipDelay = message.includes("required leg attestations found");
        if (isGossipDelay && attempt < RETRY_DELAYS_MS.length) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        setError(isGossipDelay ? "Still confirming with your driver's device. Please try again in a moment." : message);
        break;
      }
    }
    setCompleting(false);
  }

  // A cancellation is only worth disputing if a driver was involved and the
  // customer didn't cancel it themselves.
  const unfairCancellation = order.status === "Cancelled" && order.accepted_bid !== null && order.cancellation !== "ByCustomer" && order.cancellation !== "ByArbitrator";
  const canDispute = order.status === "Delivered" || unfairCancellation;

  async function cancel() {
    setCancelling(true);
    setError(null);
    try {
      await cancelOrder(orderRef);
      await reloadOrder();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setCancelling(false);
    }
  }
  // DoorDash/Uber Eats-style: one rating per store and per driver per
  // order. A merchant who ordered from their own store isn't offered the
  // store rating at all (validate_review rejects it anyway).
  const selfOrder = bytesEqual(order.merchant, myAgentPubKey());
  const canRateStore = !!rated && !rated.store && !selfOrder;
  const canRateDriver = !!rated && !rated.driver && !!driver;
  const canRateItems = !itemsRated && !order.bag_claim_ref && order.lines.length > 0;
  const ratingDone = !!rated && !canRateStore && !canRateDriver;

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.div variants={fadeSlideUp} className="mb-4 flex items-center justify-between">
        <h1 className="flex items-baseline gap-1.5 text-xl font-black text-ink-900 dark:text-ink-50">
          <StatNumber className="text-xl">{formatCents(order.order_total)}</StatNumber> order
        </h1>
        <StatusBadge status={order.status} />
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Card className="p-4">
          <OrderStatusTimeline status={order.status} cancellation={order.cancellation} />
        </Card>
      </motion.div>

      {order.status === "Placed" && snapshot && (
        <motion.div variants={fadeSlideUp}>
          <WaitingForStore writtenAt={snapshot.writtenAt} now={snapshot.now} cancelling={cancelling} onCancel={cancel} />
        </motion.div>
      )}

      <motion.div variants={fadeSlideUp}>
        <Card className="mt-3 flex flex-col gap-1 p-4 text-sm">
          <p className="text-ink-500">
            <span className="font-semibold text-ink-900 dark:text-ink-50">Drop-off: </span>
            {DROPOFF_PREFERENCE_LABEL[order.dropoff_preference]}
          </p>
          {details?.dropoff?.notes && (
            <p className="text-ink-500">
              <span className="font-semibold text-ink-900 dark:text-ink-50">Drop-off notes: </span>
              {details.dropoff.notes}
            </p>
          )}
          {details?.kitchen_note && (
            <p className="text-ink-500">
              <span className="font-semibold text-ink-900 dark:text-ink-50">Note for the store: </span>
              {details.kitchen_note}
            </p>
          )}
          {order.tip_cents > 0 && (
            <p className="text-ink-500">
              <span className="font-semibold text-ink-900 dark:text-ink-50">Tip: </span>
              {formatCents(order.tip_cents)}
            </p>
          )}
        </Card>
      </motion.div>

      {order.status === "Open" && (
        <motion.div variants={fadeSlideUp} className="mt-5">
          <h2 className="mb-2 text-sm font-bold text-ink-900 dark:text-ink-50">Driver bids</h2>
          {bids === null && (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Card key={i} className="p-3.5">
                  <Skeleton className="h-4 w-1/2 mb-2" />
                  <Skeleton className="h-3 w-1/3" />
                </Card>
              ))}
            </div>
          )}
          {bids?.length === 0 && <p className="text-xs text-ink-400">Waiting for a nearby driver to bid. This updates live.</p>}
          <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {bids?.map(({ hash: bidHash, bid, warrants: w, stats }) => {
                return (
                  <motion.div key={bytesToHex(bidHash)} layout variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0, scale: 0.97 }}>
                    <Card className="flex items-center justify-between p-3.5">
                      <div>
                        <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">
                          {stats?.displayName || `Driver ${shortAgentId(bid.bidder)}`} · {formatEta(bid.eta_seconds)}
                        </p>
                        <p className="text-xs text-ink-400">Delivery fee {formatCents(bid.price_offer)}</p>
                        {stats && (
                          <div className="mt-1 flex items-center gap-1.5">
                            {stats.reviewCount > 0 ? (
                              <StarRating value={stats.avgRating} count={stats.reviewCount} size={11} />
                            ) : (
                              <span className="text-xs text-ink-400">No reviews yet</span>
                            )}
                            <span className="text-xs text-ink-400">· {stats.completedCount} completed</span>
                          </div>
                        )}
                        {w && w.count > 0 && (
                          <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-amber-600">
                            <AlertTriangle size={12} /> {w.count} verified complaint{w.count === 1 ? "" : "s"} on record
                          </p>
                        )}
                      </div>
                      <Button
                        variant={w && w.count > 0 ? "danger" : "primary"}
                        className="px-4 py-2 text-xs"
                        loading={accepting === bytesToHex(bidHash)}
                        onClick={() => pickBid(bidHash)}
                      >
                        {w && w.count > 0 ? "Accept anyway" : "Accept"}
                      </Button>
                    </Card>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}

      {(order.status === "BidAccepted" || order.status === "MerchantConfirmed" || order.status === "DriverEnRouteToMerchant") && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex items-center gap-3 rounded-2xl bg-relay-50 dark:bg-relay-900/20 p-4">
          <Bike size={20} className="text-relay-600" />
          <p className="text-sm text-relay-700 dark:text-relay-300">Your driver is on it. This screen updates automatically as they progress.</p>
        </motion.div>
      )}

      {order.status === "PickedUp" && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex flex-col gap-3 rounded-2xl bg-relay-50 dark:bg-relay-900/20 p-4">
          <div className="flex items-center gap-3">
            <Bike size={20} className="text-relay-600" />
            <p className="text-sm text-relay-700 dark:text-relay-300">Your driver has picked up your order.</p>
          </div>
          {order.collateral_hold && (
            <p className="flex items-start gap-2 text-xs text-relay-700 dark:text-relay-300">
              <ShieldCheck size={14} className="mt-0.5 shrink-0" />
              Your driver posted {formatCents(order.order_total)} collateral with you, the value of your food. It goes back to them when you confirm receipt.
            </p>
          )}
          <Button loading={completing} onClick={confirmReceipt}>
            Confirm receipt
          </Button>
        </motion.div>
      )}

      {ACTIVE_DELIVERY_STATUSES.includes(order.status) && pickup && details?.dropoff && (
        <motion.div variants={fadeSlideUp} className="mt-4">
          <LiveMap pickup={pickup} dropoff={details.dropoff.point} driver={driverLocation} />
          {!driverLocation && <p className="mt-1 text-center text-xs text-ink-400">Waiting for your driver's live location. Not every device shares this.</p>}
        </motion.div>
      )}

      {ACTIVE_DELIVERY_STATUSES.includes(order.status) && (
        <motion.div variants={fadeSlideUp} className="mt-4">
          <ChatPanel orderRef={orderRef} title="Chat with your driver" />
        </motion.div>
      )}

      {dropoffPhoto && (
        <motion.div variants={fadeSlideUp}>
          <Card className="mt-4 p-4">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">Photo at drop-off</p>
            <img src={dropoffPhoto} alt="Delivery drop-off" className="w-full rounded-xl object-cover" />
          </Card>
        </motion.div>
      )}

      {order.status === "Open" && (
        <motion.div variants={fadeSlideUp} className="mt-6">
          <Button variant="ghost" loading={cancelling} onClick={cancel} className="w-full">
            Cancel order
          </Button>
        </motion.div>
      )}

      {canDispute && (
        <motion.div variants={fadeSlideUp} className="mt-6">
          <Button variant="ghost" loading={disputing} onClick={fileDispute} className="w-full">
            {order.status === "Cancelled" ? "This cancellation seems unfair" : "Something went wrong with this order"}
          </Button>
        </motion.div>
      )}

      {order.status === "Disputed" && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex items-center gap-3 rounded-2xl bg-red-50 dark:bg-red-900/20 p-4 text-red-700 dark:text-red-300">
          <AlertTriangle size={20} />
          <p className="text-sm">An arbitrator is reviewing this case. You'll see the outcome here once resolved.</p>
        </motion.div>
      )}

      {order.status === "Delivered" && rated && !ratingDone && (
        <motion.div variants={fadeSlideUp}>
        <Card className="mt-5 flex flex-col gap-4 p-4">
          <p className="text-sm font-bold text-ink-900 dark:text-ink-50">Rate your order</p>
          {canRateStore && (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-500">The restaurant</p>
              <StarRatingInput value={merchantRating} onChange={setMerchantRating} />
              {merchantRating > 0 && <Textarea value={merchantComment} onChange={(e) => setMerchantComment(e.target.value)} rows={2} placeholder="How was the food?" className="mt-2" />}
            </div>
          )}
          {canRateDriver && (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-500">Your driver</p>
              <StarRatingInput value={driverRating} onChange={setDriverRating} />
              {driverRating > 0 && <Textarea value={driverComment} onChange={(e) => setDriverComment(e.target.value)} rows={2} placeholder="How was the delivery?" className="mt-2" />}
            </div>
          )}
          {/* A goodie bag isn't itemized -- its one line is the bag, not a menu item -- so there's nothing per-item to rate. */}
          {canRateItems && (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-500">Rate individual items</p>
              <div className="flex flex-col gap-2">
                {order.lines.map((line) => bytesToHex(line.item_ref)).map((hex) => (
                  <div key={hex} className="flex items-center justify-between">
                    <span className="text-sm text-ink-700 dark:text-ink-300">{itemNames[hex] ?? "Item"}</span>
                    <StarRatingInput
                      value={itemRatings[hex] ?? 0}
                      onChange={(v) => setItemRatings((prev) => ({ ...prev, [hex]: v }))}
                      size={16}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          <Button
            loading={submittingReview}
            disabled={(canRateStore ? merchantRating : 0) === 0 && (canRateDriver ? driverRating : 0) === 0 && (!canRateItems || Object.values(itemRatings).every((r) => r === 0))}
            onClick={submitReviews}
          >
            Submit review
          </Button>
        </Card>
        </motion.div>
      )}

      {order.status === "Delivered" && ratingDone && (
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="mt-5 flex items-center gap-3 rounded-2xl bg-presence-500/10 p-4 text-presence-600 dark:text-presence-400">
          <CheckCircle2 size={20} />
          <p className="text-sm">Thanks for your feedback!</p>
        </motion.div>
      )}

      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </motion.div>
  );
}
