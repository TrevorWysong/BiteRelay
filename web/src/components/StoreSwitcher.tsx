import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Plus, Store } from "lucide-react";
import clsx from "clsx";
import { useActiveStore, useMerchantStores } from "../store/merchantStores";
import { formatCatalogAddress } from "../lib/format";
import { useT } from "../i18n";

/// The Uber Eats Manager / DoorDash Merchant Portal-style store picker at
/// the top of a merchant's per-store screens: shows which store you're
/// editing right now, expands to every store you run, and is where a new
/// store gets added. Inline (an expanding card) rather than a fixed sheet,
/// so none of AddressSwitcher's portal workaround is needed here.
export function StoreSwitcher() {
  const t = useT();
  const navigate = useNavigate();
  const stores = useMerchantStores((s) => s.stores) ?? [];
  const setActive = useMerchantStores((s) => s.setActive);
  const active = useActiveStore();
  const [open, setOpen] = useState(false);

  if (!active) return null;

  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-relay-100 dark:bg-relay-900/30 text-relay-600">
          <Store size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{stores.length > 1 ? t("switcher.many", { count: stores.length }) : t("role.Merchant")}</p>
          <p className="truncate text-sm font-bold text-ink-900 dark:text-ink-50">{active.catalog.business_name}</p>
        </div>
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="text-ink-400">
          <ChevronDown size={18} />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="border-t border-ink-100 dark:border-ink-800">
            {stores.map((row) => {
              const selected = row.hex === active.hex;
              const address = formatCatalogAddress(row.catalog);
              return (
                <button
                  key={row.hex}
                  onClick={() => {
                    setActive(row.hex);
                    setOpen(false);
                  }}
                  className={clsx("flex w-full items-center gap-3 px-4 py-3 text-left transition", selected ? "bg-relay-50 dark:bg-relay-900/20" : "hover:bg-ink-50 dark:hover:bg-ink-800/60")}
                >
                  <span className={clsx("h-2 w-2 shrink-0 rounded-full", row.catalog.is_open ? "bg-presence-500" : "bg-ink-300 dark:bg-ink-600")} title={row.catalog.is_open ? t("hours.open") : t("hours.closed")} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{row.catalog.business_name}</p>
                    <p className="truncate text-xs text-ink-400">{address || (row.catalog.is_open ? t("hours.open") : t("hours.closed"))}</p>
                  </div>
                  {selected && <Check size={16} className="shrink-0 text-relay-600" />}
                </button>
              );
            })}
            <button
              onClick={() => navigate("/merchant/stores/new")}
              className="flex w-full items-center gap-3 border-t border-ink-100 dark:border-ink-800 px-4 py-3 text-left text-sm font-semibold text-relay-600 hover:bg-ink-50 dark:hover:bg-ink-800/60"
            >
              <Plus size={16} /> {t("newStore.another")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
