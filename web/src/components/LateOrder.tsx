// What a delivery's customer sees when no driver is bringing it -- the part
// DoorDash handles from the middle (reassigning, refunding), done here by
// the order's own apps:
//
// - a driver late to the store is moved on by the store's app, and the
//   order goes to another driver automatically;
// - a driver who leaves an order the store started cooking answers for it
//   -- if no other driver comes in time, the customer is refunded in full;
// - meanwhile, the customer can collect it from the store themselves, and
//   the store's share of the delivery fee comes back to them;
// - a store that kept a driver waiting past its wait has its order go to
//   another driver, and its customer may cancel for a full refund.
//
// Until any of that applies, it says when it would.
import { useState } from "react";
import { Clock3, ShoppingBag } from "lucide-react";
import { cancelOrder, getOrderTiming, requestCollect } from "../holochain/zomes/dispatch";
import type { DeliveryOrder } from "../holochain/types";
import { bytesToHex } from "../holochain/decode";
import { describeError } from "../lib/errors";
import { formatClockTime } from "../lib/format";
import { POLL } from "../lib/poll";
import { useResource } from "../lib/useResource";
import { Button, Card } from "./ui";
import { Sheet } from "./Sheet";
import { useT } from "../i18n";

/// Waiting on a driver -- the statuses this applies to.
const WAITING_ON_A_DRIVER: DeliveryOrder["status"][] = ["Open", "BidAccepted", "DriverEnRouteToMerchant", "MerchantConfirmed"];

export function LateOrder({ orderRef, order, storeAddress, onChanged }: { orderRef: Uint8Array; order: DeliveryOrder; storeAddress: string; onChanged: () => Promise<void> }) {
  const waiting = WAITING_ON_A_DRIVER.includes(order.status);
  const t = useT();
  const { data: timing = null, reload } = useResource(waiting ? `order-timing:${bytesToHex(orderRef)}:${order.status}` : null, () => getOrderTiming(orderRef), { pollMs: POLL.signalled });
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!waiting || timing === null) return null;

  async function act(change: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await change();
      setConfirming(false);
      setCancelling(false);
      await reload();
      await onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }
  const collect = () => act(() => requestCollect(orderRef));

  if (timing.collect_requested) {
    return (
      <Card className="mt-4 p-4">
        <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("status.step.collecting")}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-400">{t("late.collectingAt", { place: storeAddress || t("late.counter") })}</p>
      </Card>
    );
  }

  const notes: string[] = [];
  if (timing.no_driver_after !== null) notes.push(t("late.driverLeft", { time: formatClockTime(timing.no_driver_after) }));
  if (timing.driver_due !== null && !timing.can_collect) notes.push(t("late.driverDue", { time: formatClockTime(timing.driver_due) }));

  return (
    <>
      {timing.store_was_late && (
        <Card className="mt-4 p-4">
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{t("late.storeLate")}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">{t("late.storeLateDetail")}</p>
          <Button variant="secondary" onClick={() => setCancelling(true)} className="mt-3 w-full justify-center py-2.5 text-sm">
            {t("late.cancelFull")}
          </Button>
        </Card>
      )}
      {notes.map((note) => (
        <p key={note} className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-ink-400">
          <Clock3 size={14} className="mt-0.5 shrink-0" />
          {note}
        </p>
      ))}
      {timing.can_collect && (
        <Card className="mt-4 p-4">
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{order.accepted_bid ? t("late.driverLate") : t("late.noDriver")}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-400">{t("late.finding")}</p>
          <Button variant="secondary" onClick={() => setConfirming(true)} className="mt-3 w-full justify-center py-2.5 text-sm">
            <ShoppingBag size={16} /> {t("late.collectMyself")}
          </Button>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </Card>
      )}
      <Sheet
        open={cancelling}
        onClose={() => setCancelling(false)}
        title={t("late.cancelTitle")}
        subtitle={t("late.cancelSubtitle")}
        footer={
          <Button variant="danger" loading={busy} onClick={() => act(() => cancelOrder(orderRef))} className="w-full">
            {t("late.cancelButton")}
          </Button>
        }
      >
        <p className="text-sm text-ink-500">{t("late.onRecord")}</p>
      </Sheet>
      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("late.collectTitle")}
        subtitle={storeAddress ? t("late.from", { place: storeAddress }) : t("late.fromStore")}
        footer={
          <Button loading={busy} onClick={collect} className="w-full">
            {t("late.collectButton")}
          </Button>
        }
      >
        <p className="text-sm leading-relaxed text-ink-500">
          {t("late.collectDetail")}
        </p>
      </Sheet>
    </>
  );
}
