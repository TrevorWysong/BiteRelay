import clsx from "clsx";
import { useT, type MessageKey } from "../i18n";
import { formatClockTime } from "../lib/ui/format";

/// How long a store has left to accept an order: a bar that drains in real
/// time and the time the window closes. The bar is a CSS animation started
/// from `now` (when the data was read), so nothing re-renders to tick it --
/// the screen's poll re-reads, and re-keying restarts it from the new `now`.
export function ResponseCountdown({ deadlineMs, windowSecs, now, label }: { deadlineMs: number; windowSecs: number; now: number; label: MessageKey }) {
  const t = useT();
  const remainingSecs = Math.max(0, (deadlineMs - now) / 1000);
  const startPercent = Math.min(100, (remainingSecs / windowSecs) * 100);
  const closesAt = formatClockTime(deadlineMs * 1000);
  return (
    <div className="mt-2">
      <div className="h-1 w-full overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
        <div
          key={now}
          className={clsx("h-full rounded-full", remainingSecs < 60 ? "bg-amber-500" : "bg-relay-500")}
          style={{ width: `${startPercent}%`, animation: `drain ${remainingSecs}s linear forwards` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-ink-400">
        {t(label, { time: closesAt })}
      </p>
    </div>
  );
}
