import { Check, ChefHat, CircleDot, PackageCheck, Bike, XCircle, AlertTriangle } from "lucide-react";
import type { DeliveryStatus } from "../holochain/types";
import { Badge } from "./ui";

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
    default:
      return "warn";
  }
}

export function StatusBadge({ status }: { status: DeliveryStatus }) {
  return <Badge tone={statusTone(status)}>{status.replace(/([A-Z])/g, " $1").trim()}</Badge>;
}

/// A DoorDash/UberEats-style vertical progress tracker. Cancelled/Disputed
/// render as a terminal banner instead of a step position, since they don't
/// sit on the linear happy-path sequence.
export function OrderStatusTimeline({ status }: { status: DeliveryStatus }) {
  if (status === "Cancelled") {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-ink-100 dark:bg-ink-800 px-4 py-3 text-ink-500 dark:text-ink-300">
        <XCircle size={20} />
        <span className="font-medium">This order was cancelled.</span>
      </div>
    );
  }
  if (status === "Disputed") {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-red-50 dark:bg-red-900/20 px-4 py-3 text-red-700 dark:text-red-300">
        <AlertTriangle size={20} />
        <span className="font-medium">This order is under dispute review.</span>
      </div>
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
              <div
                className={
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full " +
                  (done || active ? "bg-relay-500 text-white" : "bg-ink-100 dark:bg-ink-800 text-ink-300 dark:text-ink-600")
                }
              >
                <Icon size={16} />
              </div>
              {i < STEPS.length - 1 && (
                <div className={"w-0.5 flex-1 mt-1 " + (done ? "bg-relay-400" : "bg-ink-100 dark:bg-ink-800")} style={{ minHeight: 24 }} />
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
