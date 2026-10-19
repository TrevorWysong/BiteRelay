import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, Bike, CheckCircle2, DoorOpen, ShieldCheck, Zap } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cancelOrder, claimNeverArrived, getMyHandoverCode, getOrder, getOrderDecisions, getOrderPrivateDetails, listBidsForOrder, acceptBid, checkWarrants, getDriverLoad, confirmCollected, rankBids } from "../../holochain/zomes/dispatch";
import { confirmDeliveryReceived, HandoffNotYetHere } from "../../lib/handoffs";
import { getCatalog } from "../../holochain/zomes/catalog";
import { fetchOrderItemNames } from "../../lib/menu";
import { getHandoffEvidence, getLegsForOrder } from "../../holochain/zomes/attestation";
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
import { formatCatalogAddress, formatCents, formatEta, shortAgentId, formatClockTime, formatDeadline } from "../../lib/format";
import { received } from "../../lib/orderEntries";
import { LateOrder } from "../../components/LateOrder";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import { describeError } from "../../lib/errors";
import { useResource } from "../../lib/useResource";
import type { Bid, DeliveryOrder, DeliveryStatus, GeoPoint, InHand, Leg, LocalSignal, MerchantCatalog, Profile, Review, WarrantSummary } from "../../holochain/types";
import { carryRefusal, customerRefusal, describeLoad } from "../../lib/driverLoad";
import { useTerms } from "../../store/network";
import { POLL, isOrderSignal } from "../../lib/poll";
import { OrderReceipt } from "../../components/OrderReceipt";
import { OrderSummary } from "../../components/OrderLines";
import { OrderIssues } from "../../components/OrderIssues";
import { useT, type MessageKey } from "../../i18n";
import { HandoverCode } from "../../components/HandoverCode";
import { MAX_DESCRIPTION_CHARS } from "../../holochain/types";

// Chat is only valid once a driver is assigned (send_chat_message requires
// order.accepted_bid to exist) and before the delivery's own terminal state.
const ACTIVE_DELIVERY_STATUSES: DeliveryStatus[] = ["BidAccepted", "MerchantConfirmed", "DriverEnRouteToMerchant", "PickedUp"];

const DROPOFF_PREFERENCE_LABEL: Record<DeliveryOrder["dropoff_preference"], MessageKey> = {
  LeaveAtDoor: "cart.drop.leaveAtDoor",
  HandToMe: "cart.drop.handToMe",
  MeetOutside: "cart.drop.meetOutside",
};

interface DriverStats {
  completedCount: number;
  /// Deliveries they left before picking them up.
  droppedCount: number;
  /// Offers they let lapse, or turned down, without committing.
  lapsedCount: number;
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
  return { completedCount: summary.completed_count, droppedCount: summary.dropped_count, lapsedCount: summary.lapsed_count, avgRating: averageRating(rating) ?? 0, reviewCount: rating.count, displayName: displayName || null };
}

/// A bid's bidder, with their warrant count and driver track record.
interface BidRow {
  hash: Uint8Array;
  bid: Bid;
  /// When it was placed (microseconds).
  placedAt: number;
  warrants: WarrantSummary | null;
  stats: DriverStats | null;
  /// The orders the driver has taken on, if it could be read.
  load: InHand | null;
}

/// Bids arriving or settling, or the order changing.
const ORDER_SIGNALS = (signal: LocalSignal) => "BidPlaced" in signal || "BidAccepted" in signal || "BidReleased" in signal || isOrderSignal(signal);

/// What the customer's told while a driver has their order.
const DRIVER_PROGRESS: Partial<Record<DeliveryOrder["status"], MessageKey>> = {
  BidAccepted: "order.progress.bidAccepted",
  DriverEnRouteToMerchant: "order.progress.enRoute",
  MerchantConfirmed: "order.progress.confirmed",
  DriverAtStore: "order.progress.atStore",
};

export function OrderDetail() {
  const { hash = "" } = useParams<{ hash: string }>();
  const orderRef = hexToBytes(hash);
  const terms = useTerms();
  const t = useT();
  const [accepting, setAccepting] = useState<string | null>(null);
  const [confirmingCollected, setConfirmingCollected] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [confirmingClaim, setConfirmingClaim] = useState(false);
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
  // The store: where the order's picked up, and its address for a customer
  // collecting it themselves.
  const { data: store = null } = useResource(storeHex && `order-store:${storeHex}`, async () => {
    const catalog = decodeEntry<MerchantCatalog>(await getCatalog(order!.catalog_ref));
    return { location: catalog.location, address: formatCatalogAddress(catalog), name: catalog.business_name };
  });
  const pickup = store?.location ?? null;
  // The exact drop-off and notes are sealed; the zome opens them for us.
  const { data: details } = useResource(`order-details:${hash}`, () => getOrderPrivateDetails(orderRef));
  const { data: itemNames = {} } = useResource(order ? `order-items:${hash}` : null, () => fetchOrderItemNames(order!));
  // The drop-off photo can only appear once the order's picked up; polled
  // until the handoff leg is attested, then read once more on delivery.
  const photoStatus = order && (order.status === "PickedUp" || order.status === "Delivered") ? order.status : null;
  const { data: dropoff = null } = useResource(
    photoStatus && `order-dropoff:${hash}:${photoStatus}`,
    async () => {
      const record = (await getLegsForOrder(orderRef)).find((r) => decodeEntry<Leg>(r).kind === "CustomerHandoff");
      if (!record) return null;
      // Sealed to this customer; only they and the driver can open it.
      const evidence = await getHandoffEvidence(actionHash(record));
      return { at: timestampOf(record), photo: evidence?.photo_data_uri || null };
    },
    { pollMs: photoStatus === "PickedUp" ? POLL.signalled : undefined, refreshOn: (s) => "HandoffRecorded" in s || isOrderSignal(s) },
  );
  const dropoffPhoto = dropoff?.photo ?? null;
  // Where a claim that it never arrived stands with the store.
  const { data: decisions } = useResource(order?.status === "Disputed" ? `order-decisions:${hash}` : null, () => getOrderDecisions(orderRef), { pollMs: POLL.signalled, refreshOn: ORDER_SIGNALS });
  // The customer's handover code, while a driver's on the way: shown at the
  // door. An order left at the door has no handover.
  const handedOver = order?.dropoff_preference !== "LeaveAtDoor";
  const awaitingDriver = order && handedOver && ["BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore", "PickedUp"].includes(order.status) && !dropoff;
  // Shown to the driver at the door -- or to the store, collecting it.
  const collecting = order?.status === "Collecting";
  const { data: handoverCode = null } = useResource(awaitingDriver || collecting ? `handover-code:${hash}` : null, () => getMyHandoverCode(orderRef));
  // What this customer already rated on this order, read back from the
  // conductor rather than kept in memory -- otherwise a reload would offer
  // the rating form again and invite a duplicate.
  const { data: rated, mutate: mutateRated } = useResource(order && received(order.status) ? `order-rated:${hash}` : null, async () => {
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
          const [warrants, stats, load] = await Promise.all([
            checkWarrants(bid.bidder).catch(() => null),
            fetchDriverStats(bid.bidder).catch(() => null),
            getDriverLoad(bid.bidder).catch(() => null),
          ]);
          return { hash: actionHash(record), bid, placedAt: timestampOf(record), warrants, stats, load };
        }),
      );
    },
    { pollMs: POLL.signalled, refreshOn: ORDER_SIGNALS },
  );
  // The bids as the network's matching rule ranks them -- what an order set
  // to match automatically accepts once the bid window has run.
  const { data: ranking = [] } = useResource(order?.status === "Open" ? `order-ranking:${hash}:${bids?.length ?? 0}` : null, () => rankBids(orderRef));
  const rankOf = new Map(ranking.map((r, i) => [bytesToHex(r.bid), i]));
  const bestMatch = ranking.find((r) => r.unavailable === null);
  const rankedBids = bids && [...bids].sort((a, b) => (rankOf.get(bytesToHex(a.hash)) ?? Infinity) - (rankOf.get(bytesToHex(b.hash)) ?? Infinity));
  const firstBidAt = bids && bids.length > 0 ? Math.min(...bids.map((b) => b.placedAt)) : null;
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

  /// Accepts a bid -- `overrideWarrants` once the customer has seen the
  /// driver's complaints and chosen them anyway.
  async function confirmCollectedHere() {
    setConfirmingCollected(true);
    setError(null);
    try {
      await confirmCollected(orderRef);
      await reloadOrder();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setConfirmingCollected(false);
    }
  }

  async function pickBid(bidHash: Uint8Array, overrideWarrants: boolean) {
    setAccepting(bytesToHex(bidHash));
    setError(null);
    try {
      await acceptBid(orderRef, bidHash, overrideWarrants);
      await reloadOrder();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setAccepting(null);
    }
  }

  async function claimItNeverArrived() {
    setDisputing(true);
    setError(null);
    try {
      await claimNeverArrived(orderRef);
      setConfirmingClaim(false);
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
    // The driver's drop-off record is written on their chain and gossips
    // here; right after the handoff it may not have arrived yet. Retry a
    // few times before saying so.
    const RETRY_DELAYS_MS = [1500, 3000, 6000, 10000];
    for (let attempt = 0; ; attempt++) {
      try {
        await confirmDeliveryReceived(orderRef);
        await reloadOrder();
        break;
      } catch (err) {
        if (err instanceof HandoffNotYetHere && attempt < RETRY_DELAYS_MS.length) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        setError(describeError(err));
        break;
      }
    }
    setCompleting(false);
  }


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
          {t("order.heading")}<StatNumber className="text-xl">{formatCents(order.order_total)}</StatNumber>
        </h1>
        <div className="flex items-center gap-1.5">
          {order.priority && (
            <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
              <Zap size={11} /> {t("cart.speed.priority")}
            </span>
          )}
          <StatusBadge status={order.status} />
        </div>
      </motion.div>

      {order.status !== "Delivered" && (
        <motion.div variants={fadeSlideUp} className="-mt-2 mb-4">
          <OrderSummary orderRef={orderRef} count={order.lines.reduce((n, l) => n + l.quantity, 0)} />
        </motion.div>
      )}

      <motion.div variants={fadeSlideUp}>
        <Card className="p-4">
          <OrderStatusTimeline status={order.status} cancellation={order.cancellation} />
          {order.ready_by !== null && ["Open", "BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore"].includes(order.status) && (
            <p className="mt-3 border-t border-ink-100 dark:border-ink-800 pt-3 text-xs text-ink-500">
              {t("order.readyBy", { time: formatClockTime(order.ready_by) })}
            </p>
          )}
          {order.ready_by === null && order.prep_minutes !== null && ["Open", "BidAccepted"].includes(order.status) && (
            <p className="mt-3 border-t border-ink-100 dark:border-ink-800 pt-3 text-xs text-ink-500">
              {t("order.prepAfterDriver", { minutes: order.prep_minutes })}
            </p>
          )}
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
            <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.dropoffLabel")} </span>
            {t(DROPOFF_PREFERENCE_LABEL[order.dropoff_preference])}
          </p>
          {details?.dropoff?.notes && (
            <p className="text-ink-500">
              <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.dropoffNotesLabel")} </span>
              {details.dropoff.notes}
            </p>
          )}
          {details?.kitchen_note && (
            <p className="text-ink-500">
              <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.storeNoteLabel")} </span>
              {details.kitchen_note}
            </p>
          )}
          {order.tip_cents > 0 && (
            <p className="text-ink-500">
              <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.tipLabel")} </span>
              {formatCents(order.tip_cents)}
            </p>
          )}
        </Card>
      </motion.div>

      {order.status === "Open" && (
        <motion.div variants={fadeSlideUp} className="mt-5">
          <h2 className="mb-2 text-sm font-bold text-ink-900 dark:text-ink-50">{t("order.bids")}</h2>
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
          {bids?.length === 0 && <p className="text-xs text-ink-400">{t("order.waitingBids")}</p>}
          {order.auto_match && firstBidAt !== null && (
            <p className="mb-2 text-xs leading-relaxed text-ink-500">
              {t("order.autoMatchAt", { time: formatClockTime(firstBidAt + terms.bid_window_secs * 1_000_000), minuteValue: formatCents(terms.minute_value_cents) })}
            </p>
          )}
          <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {rankedBids?.map(({ hash: bidHash, bid, warrants: w, stats, load }) => {
                const complaints = w !== null && w.count > 0;
                const refusal = load && carryRefusal(load, order.priority, terms.max_concurrent_deliveries);
                return (
                  <motion.div key={bytesToHex(bidHash)} layout variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0, scale: 0.97 }}>
                    <Card className="flex items-center justify-between p-3.5">
                      <div>
                        <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">
                          {stats?.displayName || t("order.driverNamed", { id: shortAgentId(bid.bidder) })} · {formatEta(bid.eta_seconds)}
                          {bestMatch && bytesEqual(bestMatch.bid, bidHash) && <span className="ml-2 rounded-full bg-relay-100 px-2 py-0.5 text-[10px] font-bold text-relay-700 dark:bg-relay-900/30 dark:text-relay-300">{t("order.bestMatch")}</span>}
                        </p>
                        <p className="text-xs text-ink-400">{t("order.bidFee", { amount: formatCents(bid.price_offer) })}</p>
                        {stats && (
                          <div className="mt-1 flex items-center gap-1.5">
                            {stats.reviewCount > 0 ? (
                              <StarRating value={stats.avgRating} count={stats.reviewCount} size={11} />
                            ) : (
                              <span className="text-xs text-ink-400">{t("order.noReviews")}</span>
                            )}
                            <span className="text-xs text-ink-400">· {t("order.completed", { count: stats.completedCount })}</span>
                            {stats.droppedCount > 0 && <span className="text-xs text-amber-600">· {t("order.dropped", { count: stats.droppedCount })}</span>}
                            {stats.lapsedCount > 0 && <span className="text-xs text-ink-400">· {t("order.lapsed", { count: stats.lapsedCount })}</span>}
                          </div>
                        )}
                        {load && <p className="mt-1 text-xs text-ink-400">{describeLoad(load)}</p>}
                        {complaints && (
                          <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-amber-600">
                            <AlertTriangle size={12} /> {t("order.complaints", { count: w.count })}
                          </p>
                        )}
                      </div>
                      {refusal ? (
                        <span className="max-w-[7.5rem] text-right text-[11px] font-medium leading-tight text-ink-400">{customerRefusal(refusal)}</span>
                      ) : (
                        <Button
                          variant={complaints ? "danger" : "primary"}
                          className="px-4 py-2 text-xs"
                          loading={accepting === bytesToHex(bidHash)}
                          onClick={() => pickBid(bidHash, complaints)}
                        >
                          {complaints ? t("order.acceptAnyway") : t("order.accept")}
                        </Button>
                      )}
                    </Card>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}

      {["BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed", "DriverAtStore"].includes(order.status) && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex items-center gap-3 rounded-2xl bg-relay-50 dark:bg-relay-900/20 p-4">
          <Bike size={20} className="text-relay-600" />
          <p className="text-sm text-relay-700 dark:text-relay-300">{DRIVER_PROGRESS[order.status] && t(DRIVER_PROGRESS[order.status]!)}</p>
        </motion.div>
      )}

      {handoverCode && (
        <motion.div variants={fadeSlideUp} className="mt-4">
          <HandoverCode orderRef={orderRef} secret={handoverCode} />
        </motion.div>
      )}

      {!handedOver && ["BidAccepted", "MerchantConfirmed", "DriverEnRouteToMerchant", "PickedUp"].includes(order.status) && (
        <motion.div variants={fadeSlideUp} className="mt-4 flex items-start gap-3 rounded-2xl border border-ink-100 p-4 dark:border-ink-800">
          <DoorOpen size={20} className="mt-0.5 shrink-0 text-ink-400" />
          <p className="text-xs leading-relaxed text-ink-600 dark:text-ink-300">
            <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.door.title")}</span> {t("order.door.detail")}
          </p>
        </motion.div>
      )}

      {order.status === "PickedUp" && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex flex-col gap-3 rounded-2xl bg-relay-50 dark:bg-relay-900/20 p-4">
          <div className="flex items-center gap-3">
            <Bike size={20} className="text-relay-600" />
            <p className="text-sm text-relay-700 dark:text-relay-300">{t("order.pickedUp")}</p>
          </div>
          {order.collateral_hold && (
            <p className="flex items-start gap-2 text-xs text-relay-700 dark:text-relay-300">
              <ShieldCheck size={14} className="mt-0.5 shrink-0" />
              {t("order.collateral", { amount: formatCents(order.order_total) })}
            </p>
          )}
          {dropoff ? (
            <p className="text-xs font-semibold text-relay-700 dark:text-relay-300">{t("order.handedAt", { time: formatClockTime(dropoff.at) })}</p>
          ) : handedOver ? (
            <p className="text-xs text-relay-700 dark:text-relay-300">
              {t("order.confirmHint")}
            </p>
          ) : null}
          {handedOver && (
            <Button loading={completing} onClick={confirmReceipt}>
              {t("order.haveIt")}
            </Button>
          )}
          <AnimatePresence mode="wait" initial={false}>
            {confirmingClaim ? (
              <motion.div key="claim" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-xl bg-white p-3 dark:bg-ink-900">
                <p className="text-xs leading-relaxed text-ink-600 dark:text-ink-300">
                  {t("order.claim.warning")}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button variant="ghost" className="flex-1 py-2" onClick={() => setConfirmingClaim(false)}>
                    {t("common.back")}
                  </Button>
                  <Button variant="danger" className="flex-1 py-2" loading={disputing} onClick={claimItNeverArrived}>
                    {t("order.claim.button")}
                  </Button>
                </div>
              </motion.div>
            ) : (
              <motion.button key="ask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setConfirmingClaim(true)} className="text-xs font-semibold text-relay-700 underline-offset-4 hover:underline dark:text-relay-300">
                {t("order.claim.ask")}
              </motion.button>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {ACTIVE_DELIVERY_STATUSES.includes(order.status) && pickup && details?.dropoff && (
        <motion.div variants={fadeSlideUp} className="mt-4">
          <LiveMap pickup={pickup} dropoff={details.dropoff.point} driver={driverLocation} />
          {!driverLocation && <p className="mt-1 text-center text-xs text-ink-400">{t("order.waitingLocation")}</p>}
        </motion.div>
      )}

      {ACTIVE_DELIVERY_STATUSES.includes(order.status) && (
        <motion.div variants={fadeSlideUp} className="mt-4">
          <ChatPanel orderRef={orderRef} title={t("order.chat")} />
        </motion.div>
      )}

      {dropoffPhoto && (
        <motion.div variants={fadeSlideUp}>
          <Card className="mt-4 p-4">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">{t("order.dropoffPhoto")}</p>
            <img src={dropoffPhoto} alt={t("order.dropoffPhoto")} className="w-full rounded-xl object-cover" />
          </Card>
        </motion.div>
      )}

      <motion.div variants={fadeSlideUp}>
        <LateOrder orderRef={orderRef} order={order} storeAddress={store?.address ?? ""} onChanged={reloadOrder} />
      </motion.div>

      {collecting && (
        <motion.div variants={fadeSlideUp}>
          <Card className="mt-4 p-4">
            <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("order.collectFrom", { store: store?.name ?? t("order.theStore") })}</p>
            {store?.address && <p className="mt-0.5 text-xs text-ink-400">{store.address}</p>}
            <p className="mt-2 text-xs leading-relaxed text-ink-400">
              {t("order.collectHint")}
            </p>
            <Button loading={confirmingCollected} onClick={confirmCollectedHere} className="mt-3 w-full">
              {t("order.gotIt")}
            </Button>
          </Card>
        </motion.div>
      )}

      {order.status === "Open" && (
        <motion.div variants={fadeSlideUp} className="mt-6">
          <Button variant="ghost" loading={cancelling} onClick={cancel} className="w-full">
            {t("order.cancel")}
          </Button>
        </motion.div>
      )}

      {received(order.status) && (
        <motion.div variants={fadeSlideUp}>
          <OrderIssues orderRef={orderRef} role="customer" />
          <OrderReceipt orderRef={orderRef} />
        </motion.div>
      )}

      {order.status === "Disputed" && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex items-start gap-3 rounded-2xl bg-amber-50 p-4 text-amber-900 dark:bg-amber-900/20 dark:text-amber-100">
          <AlertTriangle size={20} className="mt-0.5 shrink-0" />
          {decisions?.not_delivered ? (
            <p className="text-sm">
              <span className="font-semibold">{t("order.refunded")}</span> {t("order.refundedDetail")}
            </p>
          ) : (
            <p className="text-sm">
              {decisions?.claim_decided_after ? t("order.claimedBy", { time: formatDeadline(decisions.claim_decided_after) }) : t("order.claimedSoon")}
            </p>
          )}
        </motion.div>
      )}

      {received(order.status) && rated && !ratingDone && (
        <motion.div variants={fadeSlideUp}>
        <Card className="mt-5 flex flex-col gap-4 p-4">
          <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{t("order.rate.title")}</p>
          {canRateStore && (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-500">{t("order.rate.store")}</p>
              <StarRatingInput value={merchantRating} onChange={setMerchantRating} />
              {merchantRating > 0 && <Textarea maxLength={MAX_DESCRIPTION_CHARS} value={merchantComment} onChange={(e) => setMerchantComment(e.target.value)} rows={2} placeholder={t("order.rate.storePlaceholder")} className="mt-2" />}
            </div>
          )}
          {canRateDriver && (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-500">{t("order.rate.driver")}</p>
              <StarRatingInput value={driverRating} onChange={setDriverRating} />
              {driverRating > 0 && <Textarea maxLength={MAX_DESCRIPTION_CHARS} value={driverComment} onChange={(e) => setDriverComment(e.target.value)} rows={2} placeholder={t("order.rate.driverPlaceholder")} className="mt-2" />}
            </div>
          )}
          {/* A goodie bag isn't itemized -- its one line is the bag, not a menu item -- so there's nothing per-item to rate. */}
          {canRateItems && (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-500">{t("order.rate.items")}</p>
              <div className="flex flex-col gap-2">
                {[...new Set(order.lines.map((line) => bytesToHex(line.item_ref)))].map((hex) => (
                  <div key={hex} className="flex items-center justify-between">
                    <span className="text-sm text-ink-700 dark:text-ink-300">{itemNames[hex] ?? t("order.item")}</span>
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
            {t("order.rate.submit")}
          </Button>
        </Card>
        </motion.div>
      )}

      {received(order.status) && ratingDone && (
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="mt-5 flex items-center gap-3 rounded-2xl bg-presence-500/10 p-4 text-presence-600 dark:text-presence-400">
          <CheckCircle2 size={20} />
          <p className="text-sm">{t("order.rate.thanks")}</p>
        </motion.div>
      )}

      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </motion.div>
  );
}
