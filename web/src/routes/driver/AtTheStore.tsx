// The driver at the store, DoorDash-style but with nobody in the middle:
//
// - **Checking in.** They scan the store's code at the counter (or type its
//   digits), which the store's own app checks. Checked in, they can't be
//   moved on -- and if the store then keeps them waiting past the network's
//   wait, they can call it late: the customer is refunded and the store
//   pays their fee.
// - **Collecting.** They show their own code; the store scans it as it
//   hands the order over, and their app picks it up on the store's record.
//
// A store that won't check them in can't be proved wrong, so reporting it
// moves no money -- it shows on the store's record, which drivers see.
import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Clock3, ScanLine, Store } from "lucide-react";
import { checkInAtStore, getLegsForOrder, recordLeg } from "../../holochain/zomes/attestation";
import { callStoreLate, getOrderTiming, pickUpOrder, reportCheckInRefused } from "../../holochain/zomes/dispatch";
import { myAgentPubKey } from "../../holochain/client";
import { actionHash, bytesEqual, bytesToHex, decodeEntry } from "../../holochain/decode";
import { HANDOFF_CODE_DIGITS, type DeliveryOrder, type GeoPoint, type Leg } from "../../holochain/types";
import { decodeHandoverCode, encodePickupCode } from "../../lib/handoverCode";
import { describeError } from "../../lib/errors";
import { formatClockTime } from "../../lib/format";
import { POLL } from "../../lib/poll";
import { currentBeacon } from "../../lib/timeSource";
import { useClock } from "../../lib/useClock";
import { useResource } from "../../lib/useResource";
import { Button, Input } from "../../components/ui";
import { QrSvg } from "../../components/HandoverCode";
import { QrScanner } from "../../components/QrScanner";
import { Sheet } from "../../components/Sheet";
import { t as translate, useT } from "../../i18n";

type Props = { orderRef: Uint8Array; order: DeliveryOrder; location: GeoPoint; onDone: () => Promise<void> };

/// On the way, or at the counter not yet checked in: check in with the
/// store's code.
export function StoreCheckIn({ orderRef, onDone }: Props) {
  const t = useT();
  const [scanning, setScanning] = useState(false);
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const orderHex = bytesToHex(orderRef);

  async function checkIn(pin: string) {
    setBusy(true);
    setError(null);
    try {
      await checkInAtStore(orderRef, pin);
      setScanning(false);
      await onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  // A scan fills in the store's digits; checking in is the driver's tap.
  const onScan = useCallback(
    (text: string) => {
      const parsed = decodeHandoverCode(text);
      if (!parsed) return setProblem(translate("scan.notRelay"));
      if (parsed.orderHex !== orderHex) return setProblem(translate("scan.otherOrder"));
      navigator.vibrate?.(40);
      setProblem(null);
      setCode(parsed.secret.pin);
      setScanning(false);
    },
    [orderHex],
  );

  async function report() {
    setBusy(true);
    setError(null);
    try {
      await reportCheckInRefused(orderRef);
      setReporting(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={() => {
          setProblem(null);
          setScanning(true);
        }}
        className="flex items-center justify-center gap-2 rounded-2xl bg-ink-900 py-3.5 text-sm font-semibold text-white transition hover:opacity-90 dark:bg-ink-50 dark:text-ink-900"
      >
        <ScanLine size={17} /> {t("store.checkIn.scan")}
      </button>
      <div className="flex items-center gap-2">
        <Input inputMode="numeric" maxLength={HANDOFF_CODE_DIGITS} placeholder={t("store.checkIn.type")} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, HANDOFF_CODE_DIGITS))} className="py-2 text-sm" />
        <Button variant="secondary" className="px-4 py-2 text-xs" loading={busy} disabled={code.length !== HANDOFF_CODE_DIGITS} onClick={() => checkIn(code)}>
          {t("store.checkIn.button")}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-ink-400">{t("store.checkIn.why")}</p>
      <button onClick={() => setReporting(true)} className="text-center text-xs font-medium text-ink-400 hover:text-ink-600">
        {t("store.checkIn.refused")}
      </button>
      {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{error}</p>}

      <Sheet open={scanning} onClose={() => setScanning(false)} title={t("store.checkIn.scanTitle")} subtitle={t("store.checkIn.scanSubtitle")}>
        <QrScanner onScan={onScan} />
        <AnimatePresence>
          {problem && (
            <motion.p initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-center text-xs font-semibold text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              {problem}
            </motion.p>
          )}
        </AnimatePresence>
      </Sheet>

      <Sheet
        open={reporting}
        onClose={() => setReporting(false)}
        title={t("store.report.title")}
        subtitle={t("store.report.subtitle")}
        footer={
          <Button loading={busy} onClick={report} className="w-full">
            {t("store.report.button")}
          </Button>
        }
      >
        <p className="text-sm leading-relaxed text-ink-500">{t("store.report.detail")}</p>
      </Sheet>
    </div>
  );
}

/// Checked in: show the store the driver's own code to hand the order over,
/// and -- once the network's wait is up -- call the store late.
export function StorePickup({ orderRef, order, location, onDone }: Props) {
  const t = useT();
  const now = useClock(15_000);
  const orderHex = bytesToHex(orderRef);
  const me = myAgentPubKey();
  // The driver's pickup leg -- recorded once, on arrival, for the store to
  // acknowledge. Read back, so a reload shows the same code.
  const { data: leg = null, reload: reloadLeg } = useResource(`pickup-leg:${orderHex}`, async () => {
    const mine = (await getLegsForOrder(orderRef)).find((r) => {
      const l = decodeEntry<Leg>(r);
      return l.kind === "MerchantHandoff" && bytesEqual(l.from, me);
    });
    return mine ? actionHash(mine) : null;
  });
  const { data: timing = null } = useResource(`order-timing:${orderHex}:${order.status}`, () => getOrderTiming(orderRef), { pollMs: POLL.signalled });
  const [confirmingLate, setConfirmingLate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(step: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const showCode = () =>
    run(async () => {
      await recordLeg({ order_ref: orderRef, sequence: 0, kind: "MerchantHandoff", to: order.merchant, geo_at_completion: location, photo_data_uri: "" });
      await reloadLeg();
    });
  const checkAgain = () =>
    run(async () => {
      await pickUpOrder(orderRef);
      await onDone();
    });
  const callLate = () =>
    run(async () => {
      await callStoreLate(orderRef, await currentBeacon());
      setConfirmingLate(false);
      await onDone();
    });

  const lateAfter = timing?.store_late_after ?? null;
  const late = lateAfter !== null && now.getTime() * 1000 >= lateAfter;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3 rounded-2xl bg-green-50 p-4 dark:bg-green-900/20">
        <Store size={20} className="mt-0.5 shrink-0 text-green-700" />
        <p className="text-xs leading-relaxed text-green-800 dark:text-green-200">{t("store.pickup.checkedIn")}</p>
      </div>
      {leg ? (
        <div className="flex flex-col items-center rounded-2xl bg-white p-4 ring-1 ring-ink-100 dark:ring-ink-800">
          <QrSvg text={encodePickupCode(orderHex, leg)} size={196} />
          <p className="mt-2 text-center text-xs text-ink-500">{t("store.pickup.show")}</p>
          <button onClick={checkAgain} disabled={busy} className="mt-2 text-xs font-semibold text-ink-500 underline-offset-4 hover:underline disabled:opacity-50">
            {t("store.pickup.checkAgain")}
          </button>
        </div>
      ) : (
        <Button className="w-full" loading={busy} onClick={showCode}>
          {t("store.pickup.showCode")}
        </Button>
      )}
      {lateAfter !== null && !late && (
        <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-400">
          <Clock3 size={14} className="mt-0.5 shrink-0" />
          {t("store.pickup.lateAt", { time: formatClockTime(lateAfter) })}
        </p>
      )}
      {late && (
        <Button variant="secondary" className="w-full" onClick={() => setConfirmingLate(true)}>
          {t("store.pickup.late")}
        </Button>
      )}
      {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{error}</p>}
      <Sheet
        open={confirmingLate}
        onClose={() => setConfirmingLate(false)}
        title={t("store.pickup.lateTitle")}
        subtitle={t("store.pickup.lateSubtitle")}
        footer={
          <Button loading={busy} onClick={callLate} className="w-full">
            {t("store.pickup.lateButton")}
          </Button>
        }
      >
        <p className="text-sm text-ink-500">{t("store.pickup.lateRecord")}</p>
      </Sheet>
    </div>
  );
}
