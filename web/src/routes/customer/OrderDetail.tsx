import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, Bike, CheckCircle2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { getOrder, listBidsForOrder, acceptBid, raiseDispute, raiseCancellationDispute, completeDelivery, checkWarrants } from "../../holochain/zomes/dispatch";
import { getCatalog, listMenuItems, getBagClaim, getGoodieBag } from "../../holochain/zomes/catalog";
import { getLegsForOrder } from "../../holochain/zomes/attestation";
import { averageRating, getMyReviewsForOrder, getRatingSummary, getReputationSummary, submitItemReview, submitReview } from "../../holochain/zomes/reputation";
import { getProfileForAgent } from "../../holochain/zomes/profiles";
import { decodeEntry, actionHash, bytesEqual, bytesToHex, hexToBytes } from "../../holochain/decode";
import { myAgentPubKey, onLocalSignal } from "../../holochain/client";
import { OrderStatusTimeline, StatusBadge } from "../../components/OrderStatus";
import { Button, Card, Skeleton, StatNumber, Textarea } from "../../components/ui";
import { StarRating, StarRatingInput } from "../../components/StarRating";
import { ChatPanel } from "../../components/ChatPanel";
import { LiveMap } from "../../components/LiveMap";
import { formatCents, formatEta, shortAgentId } from "../../lib/format";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import { describeError } from "../../lib/errors";
import type { BagClaim, Bid, DeliveryOrder, DeliveryStatus, GeoPoint, Leg, MenuItem, MerchantCatalog, Profile, Review, GoodieBag, WarrantSummary } from "../../holochain/types";

// Chat is only valid once a driver is assigned (send_chat_message requires
// order.accepted_bid to exist) and before the delivery's own terminal state.
const ACTIVE_DELIVERY_STATUSES: DeliveryStatus[] = ["BidAccepted", "MerchantConfirmed", "DriverEnRouteToMerchant", "PickedUp"];

const DROPOFF_PREFERENCE_LABEL: Record<DeliveryOrder["dropoff_preference"], string> = {
  LeaveAtDoor: "Leave at door",
  HandToMe: "Hand to me",
  MeetOutside: "Meet outside",
};

interface BidRow {
  hash: Uint8Array;
  bid: Bid;
}

interface DriverStats {
  completedCount: number;
  avgRating: number;
  reviewCount: number;
  displayName: string | null;
}

const POLL_MS = 6000;

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

export function OrderDetail() {
  const { hash } = useParams<{ hash: string }>();
  const orderRef = hash ? hexToBytes(hash) : null;
  const [order, setOrder] = useState<DeliveryOrder | null>(null);
  const [bids, setBids] = useState<BidRow[] | null>(null);
  const [driver, setDriver] = useState<Uint8Array | null>(null);
  const [warrants, setWarrants] = useState<Record<string, WarrantSummary>>({});
  const [driverStats, setDriverStats] = useState<Record<string, DriverStats>>({});
  const [accepting, setAccepting] = useState<string | null>(null);
  const [disputing, setDisputing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merchantRating, setMerchantRating] = useState(0);
  const [merchantComment, setMerchantComment] = useState("");
  const [driverRating, setDriverRating] = useState(0);
  const [driverComment, setDriverComment] = useState("");
  // What this customer has already rated on this order, read back from
  // the conductor (`get_my_reviews_for_order`) rather than kept only in
  // memory -- otherwise a reload brings the rating form straight back and
  // invites a duplicate. `null` until loaded.
  const [rated, setRated] = useState<{ store: boolean; driver: boolean } | null>(null);
  const [itemsRated, setItemsRated] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [pickup, setPickup] = useState<GeoPoint | null>(null);
  const [driverLocation, setDriverLocation] = useState<GeoPoint | null>(null);
  const [dropoffPhoto, setDropoffPhoto] = useState<string | null>(null);
  const [itemNames, setItemNames] = useState<Record<string, string>>({});
  const [itemRatings, setItemRatings] = useState<Record<string, number>>({});
  // `refresh` only closes over `hash` (see its own dep array below) --
  // reading `pickup`/`itemNames`/`dropoffPhoto`/`warrants`/`driverStats`
  // directly as "already loaded?" guards would always see each one's
  // *initial* value, since the closure capturing them is never recreated
  // on a normal poll tick. That silently turned every one of these into an
  // unconditional refetch on every single poll, forever, instead of the
  // intended "fetch once" -- refs aren't captured by value the way a
  // closed-over state variable is, so reading `.current` here always sees
  // the latest write regardless of when this closure was created.
  const loadedRef = useRef({ pickup: false, itemNames: false, dropoffPhoto: false, rated: false, warrants: new Set<string>(), driverStats: new Set<string>() });

  const refresh = useCallback(async () => {
    if (!orderRef) return;
    const record = await getOrder(orderRef);
    const decoded = decodeEntry<DeliveryOrder>(record);
    setOrder(decoded);
    if (!loadedRef.current.pickup) {
      loadedRef.current.pickup = true;
      getCatalog(decoded.catalog_ref)
        .then((r) => setPickup(decodeEntry<MerchantCatalog>(r).location))
        .catch(() => {
          loadedRef.current.pickup = false;
        });
    }
    if (!loadedRef.current.itemNames) {
      loadedRef.current.itemNames = true;
      listMenuItems(decoded.catalog_ref)
        .then((page) => {
          const names: Record<string, string> = {};
          for (const r of page.items) names[bytesToHex(actionHash(r))] = decodeEntry<MenuItem>(r).name;
          setItemNames(names);
        })
        .catch(() => {
          loadedRef.current.itemNames = false;
        });
      // A goodie-bag order's item_refs is `[bag_ref]`, not a real
      // MenuItem -- the listMenuItems lookup above never finds it, so
      // resolve its display name separately (see useClaimFinalization's
      // own construction of this order).
      if (decoded.bag_claim_ref && decoded.item_refs[0]) {
        const key = bytesToHex(decoded.item_refs[0]);
        getBagClaim(decoded.bag_claim_ref)
          .then((claimRecord) => getGoodieBag(decodeEntry<BagClaim>(claimRecord).bag_ref))
          .then((bagRecord) => setItemNames((prev) => ({ ...prev, [key]: `🎁 ${decodeEntry<GoodieBag>(bagRecord).title}` })))
          .catch(() => {});
      }
    }
    if (!loadedRef.current.dropoffPhoto && (decoded.status === "PickedUp" || decoded.status === "Delivered")) {
      loadedRef.current.dropoffPhoto = true;
      getLegsForOrder(orderRef)
        .then((records) => {
          const handoff = records.map((r) => decodeEntry<Leg>(r)).find((l) => l.kind === "CustomerHandoff");
          if (handoff?.photo_data_uri) setDropoffPhoto(handoff.photo_data_uri);
          else loadedRef.current.dropoffPhoto = false; // not attested yet -- retry next poll
        })
        .catch(() => {
          loadedRef.current.dropoffPhoto = false;
        });
    }
    if (!loadedRef.current.rated && decoded.status === "Delivered") {
      loadedRef.current.rated = true;
      getMyReviewsForOrder(orderRef)
        .then((records) => {
          const targets = records.map((r) => decodeEntry<Review>(r).target);
          setRated({ store: targets.some((t) => "Store" in t), driver: targets.some((t) => "Driver" in t) });
        })
        .catch(() => {
          loadedRef.current.rated = false;
        });
    }
    if (decoded.status === "Open") {
      const page = await listBidsForOrder(orderRef);
      const rows = page.bids.map((r) => ({ hash: actionHash(r), bid: decodeEntry<Bid>(r) }));
      setBids(rows);
      for (const row of rows) {
        const key = bytesToHex(row.bid.bidder);
        if (!loadedRef.current.warrants.has(key)) {
          loadedRef.current.warrants.add(key);
          checkWarrants(row.bid.bidder)
            .then((w) => setWarrants((prev) => ({ ...prev, [key]: w })))
            .catch(() => {
              loadedRef.current.warrants.delete(key);
            });
        }
        if (!loadedRef.current.driverStats.has(key)) {
          loadedRef.current.driverStats.add(key);
          fetchDriverStats(row.bid.bidder)
            .then((stats) => setDriverStats((prev) => ({ ...prev, [key]: stats })))
            .catch(() => {
              loadedRef.current.driverStats.delete(key);
            });
        }
      }
    } else if (decoded.accepted_bid) {
      // list_bids_for_order works regardless of the order's current status
      // (it's just a link query on the order) -- reused here to resolve
      // which bid won, since there's no direct "get bid by ref" extern.
      const page = await listBidsForOrder(orderRef);
      const won = page.bids.map((r) => decodeEntry<Bid>(r)).find((_b, i) => bytesEqual(actionHash(page.bids[i]), decoded.accepted_bid!));
      if (won) setDriver(won.bidder);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);

  async function submitReviews() {
    if (!orderRef || !order || !rated) return;
    setSubmittingReview(true);
    setError(null);
    // Each successful piece is recorded immediately, so a failure partway
    // through never re-offers (and so never double-submits) what already
    // landed.
    let next = { ...rated };
    try {
      if (merchantRating > 0 && canRateStore) {
        await submitReview({ target: { Store: order.catalog_ref }, order_original_action: orderRef, rating: merchantRating, comment: merchantComment });
        next = { ...next, store: true };
        setRated(next);
      }
      if (driverRating > 0 && driver && !next.driver) {
        await submitReview({ target: { Driver: driver }, order_original_action: orderRef, rating: driverRating, comment: driverComment });
        next = { ...next, driver: true };
        setRated(next);
      }
      if (!itemsRated) {
        for (const [itemHex, rating] of Object.entries(itemRatings)) {
          if (rating > 0) {
            await submitItemReview({ item_ref: hexToBytes(itemHex), order_original_action: orderRef, rating, comment: "" });
          }
        }
        if (Object.values(itemRatings).some((r) => r > 0)) setItemsRated(true);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmittingReview(false);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    const unsub = onLocalSignal((signal) => {
      if ("BidPlaced" in signal || "BidAccepted" in signal || "BidReleased" in signal) refresh();
      if ("LocationUpdate" in signal && orderRef && bytesEqual(signal.LocationUpdate.order_ref, orderRef)) {
        setDriverLocation({ lat: signal.LocationUpdate.lat, lon: signal.LocationUpdate.lon });
      }
    });
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [refresh]);

  if (!order || !orderRef) {
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
      await acceptBid(orderRef!, bidHash);
      await refresh();
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
        await raiseCancellationDispute({ order_original_action: orderRef!, description: "Requester believes this cancellation was unjust.", evidence_refs: [] });
      } else {
        await raiseDispute({ order_original_action: orderRef!, reason: "NeverDelivered", description: "Order never arrived.", evidence_refs: [] });
      }
      await refresh();
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
        await completeDelivery(orderRef!);
        await refresh();
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

  const canDispute = order.status === "Delivered" || order.status === "Cancelled";
  // DoorDash/Uber Eats-style: one rating per store and per driver per
  // order. A merchant who ordered from their own store isn't offered the
  // store rating at all (validate_review rejects it anyway).
  const selfOrder = bytesEqual(order.merchant, myAgentPubKey());
  const canRateStore = !!rated && !rated.store && !selfOrder;
  const canRateDriver = !!rated && !rated.driver && !!driver;
  const canRateItems = !itemsRated && !order.bag_claim_ref && order.item_refs.length > 0;
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
          <OrderStatusTimeline status={order.status} />
        </Card>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Card className="mt-3 flex flex-col gap-1 p-4 text-sm">
          <p className="text-ink-500">
            <span className="font-semibold text-ink-900 dark:text-ink-50">Drop-off: </span>
            {DROPOFF_PREFERENCE_LABEL[order.dropoff_preference]}
          </p>
          {order.special_instructions && (
            <p className="text-ink-500">
              <span className="font-semibold text-ink-900 dark:text-ink-50">Notes: </span>
              {order.special_instructions}
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
              {bids?.map(({ hash: bidHash, bid }) => {
                const w = warrants[bytesToHex(bid.bidder)];
                const stats = driverStats[bytesToHex(bid.bidder)];
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
          <Button loading={completing} onClick={confirmReceipt}>
            Confirm receipt
          </Button>
        </motion.div>
      )}

      {ACTIVE_DELIVERY_STATUSES.includes(order.status) && pickup && (
        <motion.div variants={fadeSlideUp} className="mt-4">
          <LiveMap pickup={pickup} dropoff={order.dropoff} driver={driverLocation} />
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
          {/* A goodie bag isn't itemized -- item_refs is just [bag_ref], not real MenuItems -- so there's nothing per-item to rate. */}
          {canRateItems && (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-500">Rate individual items</p>
              <div className="flex flex-col gap-2">
                {[...new Set(order.item_refs.map(bytesToHex))].map((hex) => (
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
