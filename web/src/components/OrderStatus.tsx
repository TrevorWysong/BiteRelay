import { Check, ChefHat, CircleDot, PackageCheck, Bike, XCircle, AlertTriangle, Clock } from "lucide-react";
import { motion } from "framer-motion";
import type { DeliveryStatus } from "../holochain/types";
import { Badge } from "./ui";
import { fadeSlideUp } from "../lib/motion";

const STEPS: { status: DeliveryStatus; label: string }[] = [
  { status: "Open", label: "Order placed" },
  { status: "BidAccepted", label: "Driver assigned" },
  { status: "MerchantConfirmed", label: "Prep confirmed" },
  { status: "DriverEnRouteToMerchant", label: "Driver en route to pickup" },
  { status: "PickedUp", label: "Picked up" },
  { status: "Delivered", label: "Delivered" },
];

export function statusTone(status: DeliveryStatus): "neutral" | "brand" | "success" | "warn" | "danger" {
  switch (status) {
    case "Delivered":
      return "success";
    case "Cancelled":
      return "neutral";
    case "Disputed":
      return "danger";
    case "Open":
      return "brand";
    case "Scheduled":
      return "neutral";
    default:
      return "warn";
  }
}

export function StatusBadge({ status }: { status: DeliveryStatus }) {
  return <Badge tone={statusTone(status)}>{status.replace(/([A-Z])/g, " $1").trim()}</Badge>;
}

function TerminalBanner({ icon, tone, children }: { icon: React.ReactNode; tone: "neutral" | "danger"; children: React.ReactNode }) {
  const tones = {
    neutral: "bg-ink-100 dark:bg-ink-800 text-ink-500 dark:text-ink-300",
    danger: "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300",
  };
  return (
    <motion.div initial="hidden" animate="visible" variants={fadeSlideUp} className={`flex items-center gap-3 rounded-xl px-4 py-3 ${tones[tone]}`}>
      {icon}
      <span className="font-medium">{children}</span>
    </motion.div>
  );
}

/// A DoorDash/UberEats-style vertical progress tracker. Cancelled/Disputed
/// render as a terminal banner instead of a step position, since they don't
/// sit on the linear happy-path sequence. Each step's connecting line
/// "fills" with a quick top-down scale animation as it completes, instead
/// of just snapping to its done state -- the one place in this app where
/// *progress itself* (not just a list appearing) deserves motion.
export function OrderStatusTimeline({ status }: { status: DeliveryStatus }) {
  if (status === "Scheduled") {
    return (
      <TerminalBanner icon={<Clock size={20} />} tone="neutral">
        Scheduled for later -- not yet open for driver bids.
      </TerminalBanner>
    );
  }
  if (status === "Cancelled") {
    return (
      <TerminalBanner icon={<XCircle size={20} />} tone="neutral">
        This order was cancelled.
      </TerminalBanner>
    );
  }
  if (status === "Disputed") {
    return (
      <TerminalBanner icon={<AlertTriangle size={20} />} tone="danger">
        This order is under dispute review.
      </TerminalBanner>
    );
  }

  const currentIndex = STEPS.findIndex((s) => s.status === status);
  const icons = [CircleDot, Check, ChefHat, Bike, PackageCheck, Check];

  return (
    <ol className="relative flex flex-col gap-0">
      {STEPS.map((step, i) => {
        const Icon = icons[i];
        const done = i < currentIndex;
        const active = i === currentIndex;
        return (
          <li key={step.status} className="flex gap-3 pb-6 last:pb-0">
            <div className="flex flex-col items-center">
              <motion.div
                initial={false}
                animate={{ scale: done || active ? 1 : 0.92, opacity: done || active ? 1 : 0.7 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                className={
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full " +
                  (done || active ? "bg-relay-500 text-white shadow-[var(--shadow-glow)]" : "bg-ink-100 dark:bg-ink-800 text-ink-300 dark:text-ink-600")
                }
              >
                <Icon size={16} />
              </motion.div>
              {i < STEPS.length - 1 && (
                <div className="relative mt-1 w-0.5 flex-1 overflow-hidden bg-ink-100 dark:bg-ink-800" style={{ minHeight: 24 }}>
                  <motion.div
                    className="absolute inset-x-0 top-0 bg-relay-400"
                    initial={false}
                    animate={{ height: done ? "100%" : "0%" }}
                    transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              )}
            </div>
            <div className={"pt-1 text-sm font-medium " + (done || active ? "text-ink-900 dark:text-ink-50" : "text-ink-400 dark:text-ink-600")}>
              {step.label}
              {active && <span className="ml-2 inline-block h-2 w-2 rounded-full bg-presence-500 animate-pulse align-middle" />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
