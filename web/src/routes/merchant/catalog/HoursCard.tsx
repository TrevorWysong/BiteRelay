import { useState } from "react";
import { Clock, Pencil, Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { deviceTimeZone, detailsOf, updateCatalogDetails } from "../../../holochain/zomes/catalog";
import { describeWeek, fromTimeInput, toTimeInput, WEEK } from "../../../lib/storeHours";
import { describeError } from "../../../lib/errors";
import { Button, Card, Field, Input, Switch } from "../../../components/ui";
import type { MerchantCatalog, OpeningPeriod } from "../../../holochain/types";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/// What a newly opened day starts as.
const DEFAULT_PERIOD = { opens: 9 * 60, closes: 21 * 60 };

/// When the store takes orders and how long its kitchen usually takes.
/// Checkout refuses a closed store, and the store's own conductor declines
/// an order that arrives while it's closed (`dispatch::upkeep`).
export function HoursCard({ catalog, catalogRef, onSaved }: { catalog: MerchantCatalog; catalogRef: Uint8Array; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card className="mb-4 p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
          <Clock size={12} /> Hours & prep time
        </p>
        <button onClick={() => setEditing((v) => !v)} className="text-ink-400 hover:text-relay-600" aria-label="Edit hours and prep time">
          <Pencil size={14} />
        </button>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {editing ? (
          <motion.div key="edit" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <HoursEditor
              catalog={catalog}
              onSave={async (weeklyHours, prepMinutes) => {
                // Saved in this device's time zone, which is what the times
                // were entered in.
                await updateCatalogDetails(catalogRef, { ...detailsOf(catalog), weekly_hours: weeklyHours, prep_minutes: prepMinutes, time_zone: deviceTimeZone() });
                await onSaved();
                setEditing(false);
              }}
            />
          </motion.div>
        ) : (
          <motion.div key="view" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm text-ink-600 dark:text-ink-300">
            {catalog.weekly_hours.length === 0 ? (
              <p>No set hours: you take orders whenever ordering is switched on.</p>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
                {describeWeek(catalog.weekly_hours).map(({ days, hours }) => (
                  <div key={days} className="contents">
                    <dt className="font-semibold text-ink-500">{days}</dt>
                    <dd className={hours === "Closed" ? "text-ink-400" : ""}>{hours}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p className="mt-2 text-xs text-ink-400">
              Usual prep time: {catalog.prep_minutes} min · Times in {catalog.time_zone.replace(/_/g, " ")}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

type Week = Record<number, { opens: number; closes: number }[]>;

function weekFrom(schedule: OpeningPeriod[]): Week {
  const week: Week = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const p of [...schedule].sort((a, b) => a.opens - b.opens)) week[p.weekday].push({ opens: p.opens, closes: p.closes });
  return week;
}

/// Owns its draft, seeded from the saved hours when it mounts -- so a
/// background refresh never overwrites an edit in progress.
function HoursEditor({ catalog, onSave }: { catalog: MerchantCatalog; onSave: (weeklyHours: OpeningPeriod[], prepMinutes: number) => Promise<void> }) {
  const [setHours, setSetHours] = useState(catalog.weekly_hours.length > 0);
  const [week, setWeek] = useState<Week>(() => weekFrom(catalog.weekly_hours));
  const [prep, setPrep] = useState(String(catalog.prep_minutes));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (day: number, periods: { opens: number; closes: number }[]) => setWeek((w) => ({ ...w, [day]: periods }));
  const copyToAll = (day: number) => setWeek(Object.fromEntries(WEEK.map((d) => [d, week[day].map((p) => ({ ...p }))])) as Week);
  const prepMinutes = Math.round(Number(prep));
  const prepValid = Number.isFinite(prepMinutes) && prepMinutes >= 1 && prepMinutes <= 240;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const schedule = setHours ? WEEK.flatMap((weekday) => week[weekday].map((p) => ({ weekday, ...p }))) : [];
      await onSave(schedule, prepMinutes);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">Set opening hours</p>
          <p className="text-xs text-ink-400">Off: you take orders whenever ordering is switched on.</p>
        </div>
        <Switch checked={setHours} onChange={setSetHours} label="Set opening hours" />
      </div>

      {setHours && (
        <div className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800 rounded-xl border border-ink-100 dark:border-ink-800">
          {WEEK.map((day) => (
            <div key={day} className="flex flex-col gap-1.5 px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-ink-700 dark:text-ink-200">{DAY_NAMES[day]}</span>
                <div className="flex items-center gap-3 text-[11px] font-semibold">
                  {week[day].length > 0 && (
                    <button onClick={() => copyToAll(day)} className="text-ink-400 hover:text-relay-600">
                      Copy to all days
                    </button>
                  )}
                  <button onClick={() => update(day, [...week[day], week[day].length ? { opens: 17 * 60, closes: 22 * 60 } : DEFAULT_PERIOD])} className="flex items-center gap-0.5 text-relay-600">
                    <Plus size={12} /> {week[day].length ? "Add hours" : "Open"}
                  </button>
                </div>
              </div>
              {week[day].length === 0 && <span className="text-xs text-ink-400">Closed</span>}
              {week[day].map((period, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input type="time" aria-label={`${DAY_NAMES[day]} opens`} value={toTimeInput(period.opens)} onChange={(e) => update(day, week[day].map((p, j) => (j === i ? { ...p, opens: fromTimeInput(e.target.value) } : p)))} className="py-1.5 text-xs" />
                  <span className="text-xs text-ink-400">to</span>
                  <Input type="time" aria-label={`${DAY_NAMES[day]} closes`} value={toTimeInput(period.closes)} onChange={(e) => update(day, week[day].map((p, j) => (j === i ? { ...p, closes: fromTimeInput(e.target.value) } : p)))} className="py-1.5 text-xs" />
                  <button onClick={() => update(day, week[day].filter((_, j) => j !== i))} className="text-ink-300 hover:text-red-500" aria-label="Remove these hours">
                    <X size={14} />
                  </button>
                </div>
              ))}
              {week[day].some((p) => p.closes <= p.opens) && <span className="text-[11px] text-ink-400">Closes after midnight, the next day.</span>}
              {week[day].some((p) => p.closes === p.opens) && <span className="text-[11px] text-red-600">Opening and closing can't be the same time.</span>}
            </div>
          ))}
        </div>
      )}

      <Field label="Usual prep time (minutes)">
        <Input type="number" min={1} max={240} value={prep} onChange={(e) => setPrep(e.target.value)} />
      </Field>
      <p className="text-[11px] text-ink-400">
        Customers see when their order will be ready: this long after you accept it, unless you pick a time for that order. Times are in {deviceTimeZone().replace(/_/g, " ")}, this device's time zone.
      </p>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <Button loading={saving} onClick={save} disabled={!prepValid || (setHours && WEEK.some((d) => week[d].some((p) => p.closes === p.opens)))} className="py-2 text-xs">
        Save
      </Button>
    </div>
  );
}
