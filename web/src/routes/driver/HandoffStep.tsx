// The driver handing an order to its customer. The customer proves it one
// of three ways: the driver scans their code, types the digits they read
// out (their app checks them), or they confirm in their own app. An order
// the customer chose to have left at the door needs only the drop-off and
// a photo. (At the store, the store records the handover -- see
// `AtTheStore`.)
import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, DoorOpen, ScanLine, Smartphone } from "lucide-react";
import { handoffByCode, recordLeg } from "../../holochain/zomes/attestation";
import { completeDelivery } from "../../holochain/zomes/dispatch";
import { actionHash, bytesToHex } from "../../holochain/decode";
import { HANDOFF_CODE_DIGITS, type DeliveryOrder, type GeoPoint, type PinSecret } from "../../holochain/types";
import { decodeHandoverCode, matchesCommitment } from "../../lib/handoverCode";
import { describeError } from "../../lib/errors";
import { Button } from "../../components/ui";
import { PhotoInput } from "../../components/PhotoInput";
import { QrScanner } from "../../components/QrScanner";
import { Sheet } from "../../components/Sheet";
import { t as translate, useT, type MessageKey } from "../../i18n";

const COPY = { scan: "handoff.scan", confirm: "handoff.complete", done: "handoff.waiting" } as const satisfies Record<string, MessageKey>;

/// A proof just written on the giver's chain takes a moment to reach this
/// conductor; the step it completes is retried until it has.
const RETRY_DELAYS_MS = [1500, 3000, 6000];

export function HandoffStep({ orderRef, order, location, onDone }: { orderRef: Uint8Array; order: DeliveryOrder; location: GeoPoint; onDone: () => Promise<void> }) {
  const t = useT();
  const [photo, setPhoto] = useState("");
  const [code, setCode] = useState("");
  const [scanned, setScanned] = useState<PinSecret | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanProblem, setScanProblem] = useState<string | null>(null);
  // The handoff, once recorded -- reused for a typed code or the giver's
  // own confirmation.
  const [leg, setLeg] = useState<Uint8Array | null>(null);
  const [waitingForGiver, setWaitingForGiver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = COPY;
  const leftAtDoor = order.dropoff_preference === "LeaveAtDoor";
  const commitment = order.pin_commitment;
  const orderHex = bytesToHex(orderRef);

  const onScan = useCallback(
    async (text: string) => {
      const parsed = decodeHandoverCode(text);
      if (!parsed) return setScanProblem(translate("scan.notRelay"));
      if (parsed.orderHex !== orderHex) return setScanProblem(translate("scan.otherOrder"));
      // Checked here first, so a wrong code is caught on the spot; the
      // network checks it again.
      if (!(await matchesCommitment(parsed.secret, commitment))) return setScanProblem(translate("handoff.wrongCode"));
      navigator.vibrate?.(40);
      setScanned(parsed.secret);
      setScanProblem(null);
      setScanning(false);
    },
    [orderHex, commitment],
  );

  async function record(extra: { scanned?: PinSecret; left_at_door?: boolean }): Promise<Uint8Array> {
    const record = await recordLeg({
      order_ref: orderRef,
      sequence: 1,
      kind: "CustomerHandoff",
      to: order.requester,
      geo_at_completion: location,
      photo_data_uri: photo,
      ...extra,
    });
    const hash = actionHash(record);
    setLeg(hash);
    return hash;
  }

  async function complete() {
    for (let attempt = 0; ; attempt++) {
      try {
        await completeDelivery(orderRef);
        return;
      } catch (err) {
        if (attempt >= RETRY_DELAYS_MS.length) throw err;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await step();
      await onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const finishWithScan = () =>
    run(async () => {
      await record({ scanned: scanned! });
      await complete();
    });
  const finishWithCode = () =>
    run(async () => {
      await handoffByCode(leg ?? (await record({})), code);
      await complete();
    });
  const finishAtDoor = () =>
    run(async () => {
      await record({ left_at_door: true });
      await complete();
    });
  const askGiverToConfirm = () =>
    run(async () => {
      if (!leg) await record({});
      setWaitingForGiver(true);
    });
  // A customer who confirms completes the delivery themselves.
  const checkAgain = () => run(complete);

  if (leftAtDoor) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-2xl bg-ink-50 p-4 dark:bg-ink-800/60">
          <DoorOpen size={20} className="mt-0.5 shrink-0 text-ink-500" />
          <p className="text-xs leading-relaxed text-ink-600 dark:text-ink-300">
            <span className="font-semibold text-ink-900 dark:text-ink-50">{t("handoff.door")}</span> {t("handoff.doorDetail")}
          </p>
        </div>
        <PhotoInput value={photo} onChange={setPhoto} shape="banner" className="w-full" />
        {error && <ErrorNote message={error} />}
        <Button className="w-full" loading={busy} disabled={!photo} onClick={finishAtDoor}>
          {t("handoff.leftAtDoor")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <AnimatePresence mode="wait" initial={false}>
        {scanned ? (
          <motion.div key="verified" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex items-center gap-3 rounded-2xl bg-green-50 p-4 dark:bg-green-900/20">
            <CheckCircle2 size={28} className="shrink-0 text-green-600" />
            <div>
              <p className="text-sm font-bold text-green-800 dark:text-green-200">{t("handoff.verified")}</p>
              <p className="text-xs text-green-700/80 dark:text-green-300/80">{t("handoff.paidOnConfirm")}</p>
            </div>
          </motion.div>
        ) : waitingForGiver ? (
          <motion.div key="waiting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-start gap-3 rounded-2xl bg-ink-50 p-4 dark:bg-ink-800/60">
            <Smartphone size={20} className="mt-0.5 shrink-0 text-ink-500" />
            <p className="text-xs leading-relaxed text-ink-600 dark:text-ink-300">{t(copy.done)}</p>
          </motion.div>
        ) : (
          <motion.div key="collect" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-3">
            <button
              onClick={() => {
                setScanProblem(null);
                setScanning(true);
              }}
              className="flex items-center justify-center gap-2 rounded-2xl bg-ink-900 py-3.5 text-sm font-semibold text-white transition hover:opacity-90 dark:bg-ink-50 dark:text-ink-900"
            >
              <ScanLine size={17} />
              {t(copy.scan)}
            </button>
            <p className="text-center text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t("handoff.orType")}</p>
            <PinField value={code} onChange={setCode} />
          </motion.div>
        )}
      </AnimatePresence>

      {!waitingForGiver && (
        <div>
          <p className="mb-2 text-xs font-semibold text-ink-500">{t("handoff.photo")}</p>
          <PhotoInput value={photo} onChange={setPhoto} shape="banner" className="w-full" />
        </div>
      )}

      {error && <ErrorNote message={error} />}
      {scanned ? (
        <Button className="w-full" loading={busy} onClick={finishWithScan}>
          {t(copy.confirm)}
        </Button>
      ) : waitingForGiver ? (
        <Button variant="ghost" className="w-full" loading={busy} onClick={checkAgain}>
          {t("handoff.checkAgain")}
        </Button>
      ) : (
        <>
          <Button className="w-full" loading={busy} disabled={code.length !== HANDOFF_CODE_DIGITS} onClick={finishWithCode}>
            {t(copy.confirm)}
          </Button>
          <button onClick={askGiverToConfirm} disabled={busy} className="-mt-1 text-center text-xs font-semibold text-ink-500 underline-offset-4 hover:underline disabled:opacity-50">
            {t("handoff.theyConfirm")}
          </button>
        </>
      )}

      <Sheet open={scanning} onClose={() => setScanning(false)} title={t(copy.scan)} subtitle={t("handoff.scanSubtitle")}>
        <QrScanner onScan={onScan} />
        <AnimatePresence>
          {scanProblem && (
            <motion.p initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-center text-xs font-semibold text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              {scanProblem}
            </motion.p>
          )}
        </AnimatePresence>
        <button onClick={() => setScanning(false)} className="mt-4 w-full py-2 text-sm font-semibold text-ink-500 hover:text-ink-800 dark:hover:text-ink-200">
          {t("handoff.typeInstead")}
        </button>
      </Sheet>
    </div>
  );
}

function ErrorNote({ message }: { message: string }) {
  return <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{message}</p>;
}

/// Six digit boxes over one real input: one keyboard, paste works, and
/// screen readers hear a single field.
function PinField({ value, onChange }: { value: string; onChange: (pin: string) => void }) {
  return (
    <label className="group relative block">
      <span className="sr-only">{translate("handoff.digits", { count: HANDOFF_CODE_DIGITS })}</span>
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={HANDOFF_CODE_DIGITS}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, HANDOFF_CODE_DIGITS))}
        className="absolute inset-0 h-full w-full cursor-text opacity-0"
      />
      <span className="flex justify-between gap-1.5" aria-hidden>
        {Array.from({ length: HANDOFF_CODE_DIGITS }, (_, i) => {
          const active = i === Math.min(value.length, 5);
          return (
            <span
              key={i}
              className={`grid h-14 flex-1 place-items-center rounded-xl border-2 bg-white font-mono text-2xl font-black text-ink-900 transition dark:bg-ink-900 dark:text-ink-50 ${
                active ? "border-ink-200 group-focus-within:border-relay-500 dark:border-ink-700" : value[i] ? "border-ink-300 dark:border-ink-600" : "border-ink-200 dark:border-ink-700"
              }`}
            >
              {value[i] ?? ""}
            </span>
          );
        })}
      </span>
    </label>
  );
}
