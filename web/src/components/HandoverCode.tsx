// The customer's handover code at the door: their 6-digit PIN to read out,
// and, as an option below it, the same code as a QR code for the driver to
// scan -- which confirms the delivery on the spot.
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Lock, QrCode } from "lucide-react";
import QRCode from "qrcode";
import { bytesToHex } from "../holochain/decode";
import type { ActionHash, PinSecret } from "../holochain/types";
import { encodeHandoverCode } from "../lib/handoverCode";

export function HandoverCode({ orderRef, secret, required }: { orderRef: ActionHash; secret: PinSecret; required: boolean }) {
  const [showQr, setShowQr] = useState(false);
  return (
    <div className="overflow-hidden rounded-3xl border border-ink-100 bg-white shadow-[var(--shadow-card)] dark:border-ink-800 dark:bg-ink-900/60">
      <div className="px-5 pt-5 pb-4 text-center">
        <p className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">
          <Lock size={12} /> Delivery PIN
        </p>
        <div className="mt-3 flex justify-center gap-1.5" aria-label={`PIN ${secret.pin.split("").join(" ")}`}>
          {secret.pin.split("").map((digit, i) => (
            <span key={i} className="grid h-14 w-11 place-items-center rounded-xl bg-ink-50 font-mono text-[28px] font-black text-ink-900 dark:bg-ink-800 dark:text-ink-50">
              {digit}
            </span>
          ))}
        </div>
        <p className="mx-auto mt-3 max-w-xs text-xs leading-relaxed text-ink-500 dark:text-ink-400">
          {required ? "Your driver needs this at the door." : "Give this to your driver if they ask."} Share it only once the order is in your hands.
        </p>
      </div>
      <button
        onClick={() => setShowQr((v) => !v)}
        aria-expanded={showQr}
        className="flex w-full items-center justify-center gap-2 border-t border-ink-100 py-3.5 text-sm font-semibold text-relay-600 transition hover:bg-relay-50/60 dark:border-ink-800 dark:text-relay-400 dark:hover:bg-relay-900/20"
      >
        <QrCode size={16} />
        {showQr ? "Hide scan code" : "Let your driver scan instead"}
        <ChevronDown size={16} className={`transition-transform ${showQr ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence initial={false}>
        {showQr && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <div className="flex flex-col items-center px-5 pb-5">
              {/* Always on white: scanners need the contrast, dark mode or not. */}
              <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-ink-100">
                <QrSvg text={encodeHandoverCode(bytesToHex(orderRef), secret)} size={196} />
              </div>
              <p className="mt-3 max-w-xs text-center text-xs leading-relaxed text-ink-500 dark:text-ink-400">
                Once you have your order, your driver scans this to confirm the delivery instantly. It works like your PIN: don't share it before then.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/// A QR code as crisp vector squares -- generated synchronously, nothing
/// fetched.
function QrSvg({ text, size }: { text: string; size: number }) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = modules.size;
  const quiet = 2;
  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules.get(x, y)) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n + quiet * 2} ${n + quiet * 2}`} shapeRendering="crispEdges" role="img" aria-label="Handover QR code">
      <rect width="100%" height="100%" fill="#fff" />
      <path d={path} fill="#0b0b0f" />
    </svg>
  );
}
