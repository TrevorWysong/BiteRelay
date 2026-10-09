// How a recurring order's rule reads. When it fires is the conductor's
// business (`dispatch::recurring::next_occurrence`, in the template's own
// time zone); `weekday` counts from Sunday = 0 on both sides.
import type { RecurrenceRule } from "../holochain/types";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function describeRecurrence(rule: RecurrenceRule): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  if ("Daily" in rule) return `Every day at ${pad(rule.Daily.hour)}:${pad(rule.Daily.minute)}`;
  return `Every ${WEEKDAYS[rule.Weekly.weekday]} at ${pad(rule.Weekly.hour)}:${pad(rule.Weekly.minute)}`;
}

export { WEEKDAYS };
