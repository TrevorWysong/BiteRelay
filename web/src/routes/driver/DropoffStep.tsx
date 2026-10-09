// The driver at the door: scan the customer's handover code (the delivery
// is confirmed on the spot, and the driver paid), or take their PIN, with an
// optional photo -- then record the handoff.
import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, KeyRound, ScanLine } from "lucide-react";
import { recordLeg } from "../../holochain/zomes/attestation";
import { completeDelivery } from "../../holochain/zomes/dispatch";
import { bytesToHex } from "../../holochain/decode";
import type { DeliveryOrder, GeoPoint, PinSecret } from "../../holochain/types";
import { decodeHandoverCode, matchesCommitment } from "../../lib/handoverCode";
import { describeError } from "../../lib/errors";
import { Button } from "../../components/ui";
import { PhotoInput } from "../../components/PhotoInput";
import { QrScanner } from "../../components/QrScanner";
import { Sheet } from "../../components/Sheet";

export function DropoffStep({ orderRef, order, location, onDone }: { orderRef: Uint8Array; order: DeliveryOrder; location: GeoPoint; onDone: () => Promise<void> }) {
  const [photo, setPhoto] = useState("");
  const [pin, setPin] = useState("");
  const [scanned, setScanned] = useState<PinSecret | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanProblem, setScanProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orderHex = bytesToHex(orderRef);
  const onScan = useCallback(
    async (text: string) => {
      const code = decodeHandoverCode(text);
      if (!code) return setScanProblem("That isn't a Relay handover code.");
      if (code.orderHex !== orderHex) return setScanProblem("That code is for a different order.");
      // Checked here first, so a wrong code is caught at the door; the
      // network checks it again.
      if (!(await matchesCommitment(code.secret, order.pin_commitment))) return setScanProblem("That code doesn't match this order.");
      navigator.vibrate?.(40);
      setScanned(code.secret);
      setScanProblem(null);
      setScanning(false);
    },
    [orderHex, order.pin_commitment],
  );

  const pinReady = pin.length === 6;
  const canSubmit = scanned !== null || pinReady || !order.pin_required;

  async function handOver() {
    setBusy(true);
    setError(null);
    try {
      await recordLeg({
        order_ref: orderRef,
        sequence: 1,
        kind: "CustomerHandoff",
        to: order.requester,
        geo_at_completion: location,
        photo_data_uri: photo,
        pin: scanned ? null : pin || null,
        scanned,
      });
      // A scanned code is the customer's receipt: the delivery completes now.
      if (scanned) await completeDelivery(orderRef);
      await onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <AnimatePresence mode="wait" initial={false}>
        {scanned ? (
          <motion.div key="verified" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex items-center gap-3 rounded-2xl bg-green-50 p-4 dark:bg-green-900/20">
            <CheckCircle2 size={28} className="shrink-0 text-green-600" />
            <div>
              <p className="text-sm font-bold text-green-800 dark:text-green-200">Customer's code verified</p>
              <p className="text-xs text-green-700/80 dark:text-green-300/80">The delivery completes as soon as you confirm, and you're paid right away.</p>
            </div>
          </motion.div>
        ) : (
          <motion.div key="collect" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-bold text-ink-900 dark:text-ink-50">Customer's PIN</p>
              <span className={`text-[11px] font-bold uppercase tracking-wide ${order.pin_required ? "text-relay-600" : "text-ink-400"}`}>{order.pin_required ? "Required" : "Recommended"}</span>
            </div>
            <PinField value={pin} onChange={setPin} />
            <button
              onClick={() => {
                setScanProblem(null);
                setScanning(true);
              }}
              className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-ink-200 py-3 text-sm font-semibold text-ink-700 transition hover:border-relay-400 hover:bg-relay-50/50 dark:border-ink-700 dark:text-ink-200 dark:hover:bg-relay-900/10"
            >
              <ScanLine size={17} className="text-relay-500" />
              Or scan their code
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div>
        <p className="mb-2 text-xs font-semibold text-ink-500">Photo at drop-off (optional)</p>
        <PhotoInput value={photo} onChange={setPhoto} shape="banner" className="w-full" />
      </div>

      {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{error}</p>}
      <Button className="w-full" loading={busy} disabled={!canSubmit} onClick={handOver}>
        {scanned ? "Complete delivery" : "Confirm handoff to customer"}
      </Button>
      {!canSubmit && <p className="-mt-2 text-center text-xs text-ink-400">This store requires the customer's PIN or code.</p>}

      <Sheet open={scanning} onClose={() => setScanning(false)} title="Scan the customer's code" subtitle="They'll find it under their PIN, on their order screen.">
        <QrScanner onScan={onScan} />
        <AnimatePresence>
          {scanProblem && (
            <motion.p initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-center text-xs font-semibold text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              {scanProblem}
            </motion.p>
          )}
        </AnimatePresence>
        <button onClick={() => setScanning(false)} className="mt-4 flex w-full items-center justify-center gap-2 py-2 text-sm font-semibold text-ink-500 hover:text-ink-800 dark:hover:text-ink-200">
          <KeyRound size={15} /> Enter the PIN instead
        </button>
      </Sheet>
    </div>
  );
}

/// Six digit boxes over one real input: one keyboard, paste works, and
/// screen readers hear a single field.
function PinField({ value, onChange }: { value: string; onChange: (pin: string) => void }) {
  return (
    <label className="group relative block">
      <span className="sr-only">Customer's 6-digit PIN</span>
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        className="absolute inset-0 h-full w-full cursor-text opacity-0"
      />
      <span className="flex justify-between gap-1.5" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => {
          const active = i === Math.min(value.length, 5);
          return (
            <span
              key={i}
              className={`grid h-14 flex-1 place-items-center rounded-xl border-2 font-mono text-2xl font-black text-ink-900 transition dark:text-ink-50 ${
                active ? "border-ink-200 group-focus-within:border-relay-500 dark:border-ink-700" : value[i] ? "border-ink-300 dark:border-ink-600" : "border-ink-200 dark:border-ink-700"
              } bg-white dark:bg-ink-900`}
            >
              {value[i] ?? ""}
            </span>
          );
        })}
      </span>
    </label>
  );
}
