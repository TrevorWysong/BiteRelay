// Recurring-order math -- deliberately lives entirely client-side (see
// `RecurringOrderTemplate`'s own Rust doc comment: there's no p2p cron,
// and no timezone concept anywhere in this app's Timestamps). `weekday`
// follows JS's own `Date.getDay()` convention (0 = Sunday .. 6 = Saturday)
// -- the Rust side just stores the raw number and never interprets it, so
// this convention only has to agree with itself.
import type { RecurrenceRule } from "../holochain/types";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/// The next real-world moment (in the caller's own local time) this rule
/// fires, strictly after `after`. Always advances at least one full period
/// forward, never returns a time in the past -- callers (both initial
/// creation and the firing loop's own re-advance) rely on that to never
/// get stuck re-firing the same due time repeatedly.
export function nextOccurrence(rule: RecurrenceRule, after: Date = new Date()): Date {
  const next = new Date(after);
  if ("Daily" in rule) {
    next.setHours(rule.Daily.hour, rule.Daily.minute, 0, 0);
    if (next <= after) next.setDate(next.getDate() + 1);
    return next;
  }
  const { weekday, hour, minute } = rule.Weekly;
  next.setHours(hour, minute, 0, 0);
  let diff = (weekday - next.getDay() + 7) % 7;
  if (diff === 0 && next <= after) diff = 7;
  next.setDate(next.getDate() + diff);
  return next;
}

/// Holochain Timestamps are microseconds since epoch.
export function toMicros(date: Date): number {
  return date.getTime() * 1000;
}

export function describeRecurrence(rule: RecurrenceRule): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  if ("Daily" in rule) return `Every day at ${pad(rule.Daily.hour)}:${pad(rule.Daily.minute)}`;
  return `Every ${WEEKDAYS[rule.Weekly.weekday]} at ${pad(rule.Weekly.hour)}:${pad(rule.Weekly.minute)}`;
}

export { WEEKDAYS };
