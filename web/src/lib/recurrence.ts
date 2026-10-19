// How a recurring order's rule reads. When it fires is the conductor's
// business (`dispatch::recurring::next_occurrence`, in the template's own
// time zone); `weekday` counts from Sunday = 0 on both sides.
import type { RecurrenceRule } from "../holochain/types";
import { t } from "../i18n";
import { formatTimeOfDay, weekdayName } from "./format";


export function describeRecurrence(rule: RecurrenceRule): string {
  if ("Daily" in rule) return t("recurrence.daily", { time: formatTimeOfDay(rule.Daily.hour * 60 + rule.Daily.minute) });
  return t("recurrence.weekly", { day: weekdayName(rule.Weekly.weekday), time: formatTimeOfDay(rule.Weekly.hour * 60 + rule.Weekly.minute) });
}

