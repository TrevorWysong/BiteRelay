import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, Bike, CheckCircle2 } from "lucide-react";
import { getOrder, listBidsForOrder, acceptBid, raiseDispute, raiseCancellationDispute, completeDelivery, checkWarrants } from "../../holochain/zomes/dispatch";
import { submitReview } from "../../holochain/zomes/reputation";
import { decodeEntry, actionHash, bytesEqual, bytesToHex, hexToBytes } from "../../holochain/decode";
import { onLocalSignal } from "../../holochain/client";
import { OrderStatusTimeline, StatusBadge } from "../../components/OrderStatus";
import { Button, Card, Spinner } from "../../components/ui";
import { StarRatingInput } from "../../components/StarRating";
import { formatCents, formatEta, shortAgentId } from "../../lib/format";
import type { Bid, DeliveryOrder, WarrantSummary } from "../../holochain/types";

interface BidRow {
  hash: Uint8Array;
  bid: Bid;
}

const POLL_MS = 6000;

export function OrderDetail() {
  const { hash } = useParams<{ hash: string }>();
  const orderRef = hash ? hexToBytes(hash) : null;
  const [order, setOrder] = useState<DeliveryOrder | null>(null);
  const [bids, setBids] = useState<BidRow[] | null>(null);
  const [driver, setDriver] = useState<Uint8Array | null>(null);
  const [warrants, setWarrants] = useState<Record<string, WarrantSummary>>({});
  const [accepting, setAccepting] = useState<string | null>(null);
  const [disputing, setDisputing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merchantRating, setMerchantRating] = useState(0);
  const [merchantComment, setMerchantComment] = useState("");
  const [driverRating, setDriverRating] = useState(0);
  const [driverComment, setDriverComment] = useState("");
  const [reviewsSubmitted, setReviewsSubmitted] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);

  const refresh = useCallback(async () => {
    if (!orderRef) return;
    const record = await getOrder(orderRef);
    const decoded = decodeEntry<DeliveryOrder>(record);
    setOrder(decoded);
    if (decoded.status === "Open") {
      const page = await listBidsForOrder(orderRef);
      const rows = page.bids.map((r) => ({ hash: actionHash(r), bid: decodeEntry<Bid>(r) }));
      setBids(rows);
      for (const row of rows) {
        const key = bytesToHex(row.bid.bidder);
        if (!(key in warrants)) {
          checkWarrants(row.bid.bidder)
            .then((w) => setWarrants((prev) => ({ ...prev, [key]: w })))
            .catch(() => {});
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
    if (!orderRef) return;
    setSubmittingReview(true);
    setError(null);
    try {
      if (merchantRating > 0) {
        await submitReview({ subject: order!.merchant, order_original_action: orderRef, rating: merchantRating, comment: merchantComment });
      }
      if (driverRating > 0 && driver) {
        await submitReview({ subject: driver, order_original_action: orderRef, rating: driverRating, comment: driverComment });
      }
      setReviewsSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingReview(false);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    const unsub = onLocalSignal((signal) => {
      if ("BidPlaced" in signal || "BidAccepted" in signal || "BidReleased" in signal) refresh();
    });
    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [refresh]);

  if (!order || !orderRef) {
    return (
      <div className="flex justify-center py-16 text-ink-300">
        <Spinner />
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
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDisputing(false);
    }
  }

  async function confirmReceipt() {
    setCompleting(true);
    setError(null);
    try {
      await completeDelivery(orderRef!);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompleting(false);
    }
  }

  const canDispute = order.status === "Delivered" || order.status === "Cancelled";

  return (
    <div className="px-4 pb-10 pt-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-black text-ink-900 dark:text-ink-50">{formatCents(order.order_total)} order</h1>
        <StatusBadge status={order.status} />
      </div>

      <Card className="p-4">
        <OrderStatusTimeline status={order.status} />
      </Card>

      {(order.special_instructions || order.tip_cents > 0) && (
        <Card className="mt-3 flex flex-col gap-1 p-4 text-sm">
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
      )}

      {order.status === "Open" && (
        <div className="mt-5">
          <h2 className="mb-2 text-sm font-bold text-ink-900 dark:text-ink-50">Driver bids</h2>
          {bids === null && <Spinner className="mx-auto my-4 h-5 w-5 text-ink-300" />}
          {bids?.length === 0 && <p className="text-xs text-ink-400">Waiting for a nearby driver to bid — this updates live.</p>}
          <div className="flex flex-col gap-2">
            {bids?.map(({ hash: bidHash, bid }) => {
              const w = warrants[bytesToHex(bid.bidder)];
              return (
                <Card key={bytesToHex(bidHash)} className="flex items-center justify-between p-3.5">
                  <div>
                    <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">
                      Driver {shortAgentId(bid.bidder)} · {formatEta(bid.eta_seconds)}
                    </p>
                    <p className="text-xs text-ink-400">Delivery fee {formatCents(bid.price_offer)}</p>
                    {w && w.count > 0 && (
                      <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-amber-600">
                        <AlertTriangle size={12} /> {w.count} outstanding warrant{w.count === 1 ? "" : "s"}
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
              );
            })}
          </div>
        </div>
      )}

      {(order.status === "BidAccepted" || order.status === "MerchantConfirmed" || order.status === "DriverEnRouteToMerchant") && (
        <div className="mt-5 flex items-center gap-3 rounded-2xl bg-relay-50 dark:bg-relay-900/20 p-4">
          <Bike size={20} className="text-relay-600" />
          <p className="text-sm text-relay-700 dark:text-relay-300">Your driver is on it — this screen updates automatically as they progress.</p>
        </div>
      )}

      {order.status === "PickedUp" && (
        <div className="mt-5 flex flex-col gap-3 rounded-2xl bg-relay-50 dark:bg-relay-900/20 p-4">
          <div className="flex items-center gap-3">
            <Bike size={20} className="text-relay-600" />
            <p className="text-sm text-relay-700 dark:text-relay-300">Your driver has picked up your order.</p>
          </div>
          <Button loading={completing} onClick={confirmReceipt}>
            Confirm receipt
          </Button>
        </div>
      )}

      {canDispute && (
        <div className="mt-6">
          <Button variant="ghost" loading={disputing} onClick={fileDispute} className="w-full">
            {order.status === "Cancelled" ? "This cancellation seems unfair" : "Something went wrong with this order"}
          </Button>
        </div>
      )}

      {order.status === "Disputed" && (
        <div className="mt-5 flex items-center gap-3 rounded-2xl bg-red-50 dark:bg-red-900/20 p-4 text-red-700 dark:text-red-300">
          <AlertTriangle size={20} />
          <p className="text-sm">An arbitrator is reviewing this case. You'll see the outcome here once resolved.</p>
        </div>
      )}

      {order.status === "Delivered" && !reviewsSubmitted && (
        <Card className="mt-5 flex flex-col gap-4 p-4">
          <p className="text-sm font-bold text-ink-900 dark:text-ink-50">Rate your order</p>
          <div>
            <p className="mb-1 text-xs font-semibold text-ink-500">The restaurant</p>
            <StarRatingInput value={merchantRating} onChange={setMerchantRating} />
            {merchantRating > 0 && (
              <textarea
                value={merchantComment}
                onChange={(e) => setMerchantComment(e.target.value)}
                rows={2}
                placeholder="How was the food?"
                className="mt-2 w-full resize-none rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
              />
            )}
          </div>
          {driver && (
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-500">Your driver</p>
              <StarRatingInput value={driverRating} onChange={setDriverRating} />
              {driverRating > 0 && (
                <textarea
                  value={driverComment}
                  onChange={(e) => setDriverComment(e.target.value)}
                  rows={2}
                  placeholder="How was the delivery?"
                  className="mt-2 w-full resize-none rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
                />
              )}
            </div>
          )}
          <Button loading={submittingReview} disabled={merchantRating === 0 && driverRating === 0} onClick={submitReviews}>
            Submit review
          </Button>
        </Card>
      )}

      {reviewsSubmitted && (
        <div className="mt-5 flex items-center gap-3 rounded-2xl bg-presence-500/10 p-4 text-presence-600 dark:text-presence-400">
          <CheckCircle2 size={20} />
          <p className="text-sm">Thanks for your feedback!</p>
        </div>
      )}

      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}
