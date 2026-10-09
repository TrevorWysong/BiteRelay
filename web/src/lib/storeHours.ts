// When a store takes orders -- the app's copy of `catalog_types::hours`
// (same rules, same test cases: see test/storeHours.test.ts), plus reading
// an instant in the store's own time zone and wording the result.
import type { MerchantCatalog, OpeningPeriod } from "../holochain/types";

const MINUTES_PER_DAY = 24 * 60;

/// Whether a store with `schedule` is open at `minute` (after local
/// midnight) on local `weekday` (0 = Sunday). An empty schedule means no
/// set hours. A period that closes at or before it opens runs past midnight.
export function openAt(schedule: OpeningPeriod[], weekday: number, minute: number): boolean {
  if (schedule.length === 0) return true;
  const yesterday = (weekday + 6) % 7;
  return schedule.some((p) => {
    const overnight = p.closes <= p.opens;
    if (p.weekday === weekday) return minute >= p.opens && (overnight || minute < p.closes);
    return p.weekday === yesterday && overnight && minute < p.closes;
  });
}

/// The next opening strictly after `minute` on `weekday`: days ahead and
/// the minute it opens. `null` for an empty schedule.
export function nextOpening(schedule: OpeningPeriod[], weekday: number, minute: number): { daysAhead: number; minute: number } | null {
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = (weekday + ahead) % 7;
    const opens = schedule
      .filter((p) => p.weekday === day)
      .map((p) => p.opens)
      .sort((a, b) => a - b)
      .find((opens) => ahead > 0 || opens > minute);
    if (opens !== undefined) return { daysAhead: ahead, minute: opens };
  }
  return null;
}

/// When the period open at `minute` on `weekday` closes, if one is.
export function closesAt(schedule: OpeningPeriod[], weekday: number, minute: number): number | null {
  const yesterday = (weekday + 6) % 7;
  const current = schedule.find((p) => {
    const overnight = p.closes <= p.opens;
    if (p.weekday === weekday) return minute >= p.opens && (overnight || minute < p.closes);
    return p.weekday === yesterday && overnight && minute < p.closes;
  });
  return current ? current.closes : null;
}

/// The local weekday (0 = Sunday) and minute after midnight of `at` in
/// `timeZone`; an unknown zone reads as UTC.
export function localWeekdayMinute(timeZone: string, at: Date): { weekday: number; minute: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  } catch {
    return localWeekdayMinute("UTC", at);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { weekday, minute: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

/// "8:00 AM" for 480.
export function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${m.toString().padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/// "08:00" (an `<input type="time">` value) <-> minutes after midnight.
export const toTimeInput = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export const fromTimeInput = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return Math.min(MINUTES_PER_DAY - 1, (h || 0) * 60 + (m || 0));
};

export interface StoreStatus {
  open: boolean;
  /// "Open until 10:00 PM", "Closed · opens 8:00 AM tomorrow", ...
  label: string;
}

/// Whether `catalog` is taking orders at `at`, worded for a customer.
export function storeStatus(catalog: Pick<MerchantCatalog, "is_open" | "weekly_hours" | "time_zone">, at: Date): StoreStatus {
  if (!catalog.is_open) return { open: false, label: "Not taking orders right now" };
  const { weekday, minute } = localWeekdayMinute(catalog.time_zone, at);
  if (openAt(catalog.weekly_hours, weekday, minute)) {
    const closes = closesAt(catalog.weekly_hours, weekday, minute);
    return { open: true, label: closes === null ? "Open" : `Open until ${formatMinute(closes)}` };
  }
  const next = nextOpening(catalog.weekly_hours, weekday, minute);
  if (!next) return { open: false, label: "Closed" };
  const when = next.daysAhead === 0 ? "" : next.daysAhead === 1 ? " tomorrow" : ` ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][(weekday + next.daysAhead) % 7]}`;
  return { open: false, label: `Closed · opens ${formatMinute(next.minute)}${when}` };
}

/// Monday first, as a week reads.
export const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// A schedule as lines a person reads -- consecutive days with the same
/// hours run together: "Mon–Fri" / "8:00 AM – 10:00 PM".
export function describeWeek(schedule: OpeningPeriod[]): { days: string; hours: string }[] {
  const hoursOf = (day: number) =>
    schedule
      .filter((p) => p.weekday === day)
      .sort((a, b) => a.opens - b.opens)
      .map((p) => `${formatMinute(p.opens)} – ${formatMinute(p.closes)}`)
      .join(", ") || "Closed";
  const lines: { from: number; to: number; hours: string }[] = [];
  for (const day of WEEK) {
    const hours = hoursOf(day);
    const last = lines[lines.length - 1];
    if (last && last.hours === hours) last.to = day;
    else lines.push({ from: day, to: day, hours });
  }
  return lines.map(({ from, to, hours }) => ({ days: from === to ? SHORT_DAYS[from] : `${SHORT_DAYS[from]}–${SHORT_DAYS[to]}`, hours }));
}
