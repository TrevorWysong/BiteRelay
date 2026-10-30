// A driver's own limits on what they're offered -- each within the
// network's, which it enforces regardless -- the speed their bid ETAs are
// estimated from, and their rule for bidding automatically. Kept on this
// device (`roleSettings`).
import { useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Card, Input, Switch } from "../../components/ui";
import { currencySymbol, formatCents, fromMinorUnits, toMinorUnits } from "../../lib/ui/format";
import { useTerms } from "../../store/network";
import { useDriverSettings } from "../../store/roleSettings";
import { useT } from "../../i18n";

export function DriverSettingsCard() {
  const t = useT();
  const networkMax = useTerms().max_concurrent_deliveries;
  const { limits, travelSpeedKmh, setLimits, setTravelSpeed, autoBid, setAutoBid } = useDriverSettings();
  const [open, setOpen] = useState(false);
  const atOnce = Math.min(limits.maxAtOnce ?? networkMax, networkMax);
  const summary = [
    t("driverSettings.upTo", { count: atOnce }),
    limits.takePriority ? t("driverSettings.priorityOn") : t("driverSettings.priorityOff"),
    limits.minFeeCents > 0 ? t("driverSettings.minFee", { amount: formatCents(limits.minFeeCents) }) : null,
    autoBid.on ? t("driverSettings.bidding", { amount: formatCents(autoBid.perKmCents) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="mb-5 p-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-left" aria-expanded={open}>
        <span className="flex items-center gap-2">
          <SlidersHorizontal size={16} className="text-ink-400" />
          <span>
            <span className="block text-sm font-semibold text-ink-900 dark:text-ink-50">{t("driverSettings.title")}</span>
            <span className="block text-xs text-ink-400">{summary}</span>
          </span>
        </span>
        <ChevronDown size={16} className={`text-ink-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mt-4 flex flex-col gap-4">
              <div>
                <p className="mb-2 text-xs font-semibold text-ink-500">{t("driverSettings.most")}</p>
                <div className="flex gap-2">
                  {Array.from({ length: networkMax }, (_, i) => i + 1).map((count) => (
                    <button
                      key={count}
                      onClick={() => setLimits({ maxAtOnce: count === networkMax ? null : count })}
                      className={`h-9 w-9 rounded-full text-sm font-semibold transition ${count === atOnce ? "bg-relay-500 text-white" : "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300"}`}
                    >
                      {count}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-ink-400">{t("driverSettings.networkAllows", { count: networkMax })}</p>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>
                  <span className="block text-xs font-semibold text-ink-500">{t("driverSettings.priority")}</span>
                  <span className="block text-[11px] text-ink-400">{t("driverSettings.priorityDetail")}</span>
                </span>
                <Switch checked={limits.takePriority} onChange={(takePriority) => setLimits({ takePriority })} label={t("driverSettings.takePriority")} />
              </div>
              <div className="flex gap-3">
                <label className="flex-1 text-xs font-semibold text-ink-500">
                  {t("driverSettings.lowestFee")}
                  <Input
                    type="number"
                    min={0}
                    step={0.5}
                    value={fromMinorUnits(limits.minFeeCents)}
                    onChange={(e) => setLimits({ minFeeCents: Math.max(0, toMinorUnits(Number(e.target.value))) })}
                    prefix={currencySymbol()}
                    className="mt-1 py-1.5 text-sm"
                  />
                </label>
                <label className="flex-1 text-xs font-semibold text-ink-500">
                  {t("driverSettings.speed")}
                  <Input type="number" min={1} step={1} value={travelSpeedKmh} onChange={(e) => setTravelSpeed(Math.max(1, Math.round(Number(e.target.value))))} suffix="km/h" className="mt-1 py-1.5 text-sm" />
                </label>
              </div>
              <p className="text-[11px] text-ink-400">{t("driverSettings.speedNote")}</p>
              <div className="flex items-center justify-between gap-3 border-t border-ink-100 pt-4 dark:border-ink-800">
                <span>
                  <span className="block text-xs font-semibold text-ink-500">{t("driverSettings.autoBid")}</span>
                  <span className="block text-[11px] text-ink-400">{t("driverSettings.autoBidDetail")}</span>
                </span>
                <Switch checked={autoBid.on} onChange={(on) => setAutoBid({ on })} label={t("driverSettings.autoBidLabel")} />
              </div>
              {autoBid.on && (
                <div className="flex gap-3">
                  <label className="flex-1 text-xs font-semibold text-ink-500">
                    {t("driverSettings.rate")}
                    <Input
                      type="number"
                      min={0}
                      step={0.1}
                      value={fromMinorUnits(autoBid.perKmCents)}
                      onChange={(e) => setAutoBid({ perKmCents: Math.max(0, toMinorUnits(Number(e.target.value))) })}
                      prefix={currencySymbol()}
                      className="mt-1 py-1.5 text-sm"
                    />
                  </label>
                  <label className="flex-1 text-xs font-semibold text-ink-500">
                    {t("driverSettings.skip")}
                    <Input type="number" min={1} step={1} value={autoBid.skipRefusals} onChange={(e) => setAutoBid({ skipRefusals: Math.max(1, Math.round(Number(e.target.value))) })} suffix={t("driverSettings.times")} className="mt-1 py-1.5 text-sm" />
                  </label>
                </div>
              )}
              {autoBid.on && <p className="text-[11px] text-ink-400">{t("driverSettings.autoBidNote")}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}
