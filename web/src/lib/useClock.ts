import { useState } from "react";
import { usePolling } from "./useResource";

/// The current time, refreshed every `everyMs` while visible -- for what a
/// screen shows that depends on the clock ("Open until 10:00 PM"), which
/// rendering mustn't read from `Date.now()` itself.
export function useClock(everyMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  usePolling(() => setNow(new Date()), { pollMs: everyMs });
  return now;
}
