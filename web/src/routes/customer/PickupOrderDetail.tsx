import { useState } from "react";
import { useResource } from "../../lib/useResource";
import { useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ChefHat } from "lucide-react";
import { motion } from "framer-motion";
import { getPickupOrder, raisePickupDispute, completePickup } from "../../holochain/zomes/dispatch";
import { fetchOrderItemNames } from "../../lib/menu";
import { getMyReviewsForOrder, submitReview, submitItemReview } from "../../holochain/zomes/reputation";
import { decodeEntry, bytesEqual, bytesToHex, hexToBytes } from "../../holochain/decode";
import { myAgentPubKey } from "../../holochain/client";
import { PickupStatusTimeline, PickupStatusBadge } from "../../components/OrderStatus";
import { Button, Card, Skeleton, StatNumber, Textarea } from "../../components/ui";
import { StarRatingInput } from "../../components/StarRating";
import { formatCents } from "../../lib/format";
import { fadeSlideUp, staggerContainer } from "../../lib/motion";
import { describeError } from "../../lib/errors";
import type { PickupOrder, Review } from "../../holochain/types";

const POLL_MS = 6000;

/// `OrderDetail`'s pickup sibling -- no bids, no driver, no live map, no
/// chat: the requester and the merchant are the only two parties, and
/// there's nothing to track en route since there's no en route. See
/// `PickupOrder`'s own doc comment (`dispatch_integrity`) for why this is a
/// wholly separate entry type and screen rather than a conditional branch
/// inside `OrderDetail`.
export function PickupOrderDetail() {
  const { hash = "" } = useParams<{ hash: string }>();
  const orderRef = hexToBytes(hash);
  const [disputing, setDisputing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merchantRating, setMerchantRating] = useState(0);
  const [merchantComment, setMerchantComment] = useState("");
  const [itemsRated, setItemsRated] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [itemRatings, setItemRatings] = useState<Record<string, number>>({});

  const { data: order, reload: reloadOrder } = useResource(`pickup-order:${hash}`, async () => decodeEntry<PickupOrder>(await getPickupOrder(orderRef)), {
    pollMs: POLL_MS,
    refreshOn: (signal) => "PickupReady" in signal,
  });
  const { data: itemNames = {} } = useResource(order ? `pickup-order-items:${hash}` : null, () => fetchOrderItemNames(order!));
  // Read back from the conductor so a reload doesn't re-offer the form (see
  // OrderDetail). `undefined` until loaded.
  const { data: storeRated, mutate: mutateStoreRated } = useResource(order?.status === "PickedUp" ? `pickup-order-rated:${hash}` : null, async () =>
    (await getMyReviewsForOrder(orderRef)).some((r) => "Store" in decodeEntry<Review>(r).target),
  );

  if (!order) {
    return (
      <div className="flex flex-col gap-3 px-4 pt-4">
        <Skeleton className="h-7 w-2/5" />
        <Card className="p-4">
          <Skeleton className="h-4 w-full mb-3" />
          <Skeleton className="h-4 w-3/4 mb-3" />
          <Skeleton className="h-4 w-1/2" />
        </Card>
      </div>
    );
  }

  async function fileDispute() {
    setDisputing(true);
    setError(null);
    try {
      await raisePickupDispute({ order_original_action: orderRef, reason: "NeverDelivered", description: "Order was never ready/handed over.", evidence_refs: [] });
      await reloadOrder();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setDisputing(false);
    }
  }

  async function confirmPickup() {
    setCompleting(true);
    setError(null);
    try {
      await completePickup(orderRef);
      await reloadOrder();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setCompleting(false);
    }
  }

  async function submitReviews() {
    if (!order) return;
    setSubmittingReview(true);
    setError(null);
    try {
      if (merchantRating > 0 && canRateStore) {
        await submitReview({ target: { Store: order.catalog_ref }, order_original_action: orderRef, rating: merchantRating, comment: merchantComment });
        mutateStoreRated(() => true);
      }
      if (canRateItems) {
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

  const canDispute = order.status === "PickedUp" || order.status === "Cancelled";
  // A merchant collecting from their own store has nothing to rate --
  // validate_review/validate_item_review reject self-ratings anyway.
  const selfOrder = bytesEqual(order.merchant, myAgentPubKey());
  const canRateStore = storeRated === false && !selfOrder;
  const canRateItems = !itemsRated && !selfOrder && !order.bag_claim_ref && order.item_refs.length > 0;

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.div variants={fadeSlideUp} className="mb-4 flex items-center justify-between">
        <h1 className="flex items-baseline gap-1.5 text-xl font-black text-ink-900 dark:text-ink-50">
          <StatNumber className="text-xl">{formatCents(order.order_total)}</StatNumber> pickup
        </h1>
        <PickupStatusBadge status={order.status} />
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Card className="p-4">
          <PickupStatusTimeline status={order.status} />
        </Card>
      </motion.div>

      {order.special_instructions && (
        <motion.div variants={fadeSlideUp}>
          <Card className="mt-3 flex flex-col gap-1 p-4 text-sm">
            <p className="text-ink-500">
              <span className="font-semibold text-ink-900 dark:text-ink-50">Notes: </span>
              {order.special_instructions}
            </p>
          </Card>
        </motion.div>
      )}

      {(order.status === "Placed" || order.status === "MerchantConfirmed") && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex items-center gap-3 rounded-2xl bg-relay-50 dark:bg-relay-900/20 p-4">
          <ChefHat size={20} className="text-relay-600" />
          <p className="text-sm text-relay-700 dark:text-relay-300">The merchant is preparing your order. This screen updates automatically.</p>
        </motion.div>
      )}

      {order.status === "ReadyForPickup" && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex flex-col gap-3 rounded-2xl bg-relay-50 dark:bg-relay-900/20 p-4">
          <div className="flex items-center gap-3">
            <ChefHat size={20} className="text-relay-600" />
            <p className="text-sm text-relay-700 dark:text-relay-300">Your order is ready for pickup.</p>
          </div>
          <Button loading={completing} onClick={confirmPickup}>
            I picked this up
          </Button>
        </motion.div>
      )}

      {canDispute && (
        <motion.div variants={fadeSlideUp} className="mt-6">
          <Button variant="ghost" loading={disputing} onClick={fileDispute} className="w-full">
            Something went wrong with this order
          </Button>
        </motion.div>
      )}

      {order.status === "Disputed" && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex items-center gap-3 rounded-2xl bg-red-50 dark:bg-red-900/20 p-4 text-red-700 dark:text-red-300">
          <AlertTriangle size={20} />
          <p className="text-sm">An arbitrator is reviewing this case. You'll see the outcome here once resolved.</p>
        </motion.div>
      )}

      {order.status === "PickedUp" && canRateStore && (
        <motion.div variants={fadeSlideUp}>
          <Card className="mt-5 flex flex-col gap-4 p-4">
            <p className="text-sm font-bold text-ink-900 dark:text-ink-50">Rate your order</p>
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-500">The restaurant</p>
              <StarRatingInput value={merchantRating} onChange={setMerchantRating} />
              {merchantRating > 0 && <Textarea value={merchantComment} onChange={(e) => setMerchantComment(e.target.value)} rows={2} placeholder="How was the food?" className="mt-2" />}
            </div>
            {canRateItems && (
              <div>
                <p className="mb-1 text-xs font-semibold text-ink-500">Rate individual items</p>
                <div className="flex flex-col gap-2">
                  {[...new Set(order.item_refs.map(bytesToHex))].map((hex) => (
                    <div key={hex} className="flex items-center justify-between">
                      <span className="text-sm text-ink-700 dark:text-ink-300">{itemNames[hex] ?? "Item"}</span>
                      <StarRatingInput value={itemRatings[hex] ?? 0} onChange={(v) => setItemRatings((prev) => ({ ...prev, [hex]: v }))} size={16} />
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Button loading={submittingReview} disabled={merchantRating === 0 && (!canRateItems || Object.values(itemRatings).every((r) => r === 0))} onClick={submitReviews}>
              Submit review
            </Button>
          </Card>
        </motion.div>
      )}

      {order.status === "PickedUp" && storeRated === true && !selfOrder && (
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="mt-5 flex items-center gap-3 rounded-2xl bg-presence-500/10 p-4 text-presence-600 dark:text-presence-400">
          <CheckCircle2 size={20} />
          <p className="text-sm">Thanks for your feedback!</p>
        </motion.div>
      )}

      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </motion.div>
  );
}
