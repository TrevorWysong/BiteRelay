import { useState } from "react";
import { useResource } from "../../lib/hooks/useResource";
import { useParams } from "react-router-dom";
import { CheckCircle2, ChefHat } from "lucide-react";
import { motion } from "framer-motion";
import { cancelPickupOrder, getOrderPrivateDetails, getPickupOrder, reportPickupProblem, completePickup } from "../../holochain/zomes/dispatch";
import { fetchOrderItemNames } from "../../lib/menu/menu";
import { getMyReviewsForOrder, submitReview, submitItemReview } from "../../holochain/zomes/reputation";
import { decodeEntry, bytesEqual, bytesToHex, hexToBytes, timestampOf } from "../../holochain/decode";
import { myAgentPubKey } from "../../holochain/client";
import { PickupStatusTimeline, PickupStatusBadge } from "../../components/OrderStatus";
import { Button, Card, Skeleton, StatNumber, Textarea } from "../../components/ui";
import { StarRatingInput } from "../../components/StarRating";
import { WaitingForStore } from "../../components/WaitingForStore";
import { formatCents, formatClockTime } from "../../lib/ui/format";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { describeError } from "../../lib/ui/errors";
import type { PickupOrder, Review } from "../../holochain/types";
import { POLL, isOrderSignal } from "../../lib/network/poll";
import { OrderReceipt } from "../../components/OrderReceipt";
import { OrderSummary } from "../../components/OrderLines";
import { OrderIssues } from "../../components/OrderIssues";
import { MAX_DESCRIPTION_CHARS } from "../../holochain/types";
import { useT } from "../../i18n";


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
  const t = useT();
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merchantRating, setMerchantRating] = useState(0);
  const [merchantComment, setMerchantComment] = useState("");
  const [itemsRated, setItemsRated] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [itemRatings, setItemRatings] = useState<Record<string, number>>({});

  // `writtenAt` (when its current version was written) and `now` (when it
  // was read) time the store's window to accept it.
  const { data: snapshot, reload: reloadOrder } = useResource(
    `pickup-order:${hash}`,
    async () => {
      const record = await getPickupOrder(orderRef);
      return { order: decodeEntry<PickupOrder>(record), writtenAt: timestampOf(record), now: Date.now() };
    },
    { pollMs: POLL.signalled, refreshOn: (signal) => "PickupReady" in signal || isOrderSignal(signal) },
  );
  const order = snapshot?.order;
  // The kitchen note is sealed to the store; the zome opens it for us.
  const { data: details } = useResource(`pickup-order-details:${hash}`, () => getOrderPrivateDetails(orderRef));
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
      await reportPickupProblem(orderRef);
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


  async function cancel() {
    setCancelling(true);
    setError(null);
    try {
      await cancelPickupOrder(orderRef);
      await reloadOrder();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setCancelling(false);
    }
  }
  // A merchant collecting from their own store has nothing to rate --
  // validate_review/validate_item_review reject self-ratings anyway.
  const selfOrder = bytesEqual(order.merchant, myAgentPubKey());
  const canRateStore = storeRated === false && !selfOrder;
  const canRateItems = !itemsRated && !selfOrder && !order.bag_claim_ref && order.lines.length > 0;

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.div variants={fadeSlideUp} className="mb-4 flex items-center justify-between">
        <h1 className="flex items-baseline gap-1.5 text-xl font-black text-ink-900 dark:text-ink-50">
          {t("pickup.heading")}<StatNumber className="text-xl">{formatCents(order.order_total)}</StatNumber>
        </h1>
        <PickupStatusBadge status={order.status} />
      </motion.div>

      {order.status !== "PickedUp" && (
        <motion.div variants={fadeSlideUp} className="-mt-2 mb-4">
          <OrderSummary orderRef={orderRef} count={order.lines.reduce((n, l) => n + l.quantity, 0)} />
        </motion.div>
      )}

      <motion.div variants={fadeSlideUp}>
        <Card className="p-4">
          <PickupStatusTimeline status={order.status} cancellation={order.cancellation} />
        </Card>
      </motion.div>

      {details?.kitchen_note && (
        <motion.div variants={fadeSlideUp}>
          <Card className="mt-3 flex flex-col gap-1 p-4 text-sm">
            <p className="text-ink-500">
              <span className="font-semibold text-ink-900 dark:text-ink-50">{t("order.storeNoteLabel")} </span>
              {details.kitchen_note}
            </p>
          </Card>
        </motion.div>
      )}

      {order.status === "Placed" && snapshot && (
        <motion.div variants={fadeSlideUp}>
          <WaitingForStore writtenAt={snapshot.writtenAt} now={snapshot.now} cancelling={cancelling} onCancel={cancel} />
        </motion.div>
      )}

      {order.status === "MerchantConfirmed" && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex items-center gap-3 rounded-2xl bg-handshake-50 dark:bg-handshake-900/20 p-4">
          <ChefHat size={20} className="text-handshake-600" />
          <p className="text-sm text-handshake-700 dark:text-handshake-300">
            {order.ready_by !== null ? t("pickup.preparingBy", { time: formatClockTime(order.ready_by) }) : t("pickup.preparing")}
          </p>
        </motion.div>
      )}

      {(order.status === "ReadyForPickup" || order.status === "Disputed") && (
        <motion.div variants={fadeSlideUp} className="mt-5 flex flex-col gap-3 rounded-2xl bg-handshake-50 dark:bg-handshake-900/20 p-4">
          <div className="flex items-center gap-3">
            <ChefHat size={20} className="text-handshake-600" />
            <p className="text-sm text-handshake-700 dark:text-handshake-300">
              {order.status === "Disputed" ? t("pickup.disputed") : t("pickup.ready")}
            </p>
          </div>
          <Button loading={completing} onClick={confirmPickup}>
            {t("pickup.pickedUp")}
          </Button>
          {order.status === "ReadyForPickup" && (
            <button onClick={fileDispute} disabled={disputing} className="text-xs font-semibold text-handshake-700 underline-offset-4 hover:underline disabled:opacity-50 dark:text-handshake-300">
              {t("pickup.cantGet")}
            </button>
          )}
        </motion.div>
      )}

      {order.status === "PickedUp" && (
        <motion.div variants={fadeSlideUp}>
          <OrderIssues orderRef={orderRef} role="customer" />
          <OrderReceipt orderRef={orderRef} />
        </motion.div>
      )}


      {order.status === "PickedUp" && canRateStore && (
        <motion.div variants={fadeSlideUp}>
          <Card className="mt-5 flex flex-col gap-4 p-4">
            <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{t("order.rate.title")}</p>
            <div>
              <p className="mb-1 text-xs font-semibold text-ink-500">{t("order.rate.store")}</p>
              <StarRatingInput value={merchantRating} onChange={setMerchantRating} />
              {merchantRating > 0 && <Textarea maxLength={MAX_DESCRIPTION_CHARS} value={merchantComment} onChange={(e) => setMerchantComment(e.target.value)} rows={2} placeholder={t("order.rate.storePlaceholder")} className="mt-2" />}
            </div>
            {canRateItems && (
              <div>
                <p className="mb-1 text-xs font-semibold text-ink-500">{t("order.rate.items")}</p>
                <div className="flex flex-col gap-2">
                  {[...new Set(order.lines.map((line) => bytesToHex(line.item_ref)))].map((hex) => (
                    <div key={hex} className="flex items-center justify-between">
                      <span className="text-sm text-ink-700 dark:text-ink-300">{itemNames[hex] ?? t("order.item")}</span>
                      <StarRatingInput value={itemRatings[hex] ?? 0} onChange={(v) => setItemRatings((prev) => ({ ...prev, [hex]: v }))} size={16} />
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Button loading={submittingReview} disabled={merchantRating === 0 && (!canRateItems || Object.values(itemRatings).every((r) => r === 0))} onClick={submitReviews}>
              {t("order.rate.submit")}
            </Button>
          </Card>
        </motion.div>
      )}

      {order.status === "PickedUp" && storeRated === true && !selfOrder && (
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="mt-5 flex items-center gap-3 rounded-2xl bg-presence-500/10 p-4 text-presence-600 dark:text-presence-400">
          <CheckCircle2 size={20} />
          <p className="text-sm">{t("order.rate.thanks")}</p>
        </motion.div>
      )}

      {error && <p className="mt-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </motion.div>
  );
}
