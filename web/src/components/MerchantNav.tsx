import { NavLink, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { BellRing, ClipboardList, Store } from "lucide-react";
import { useMyStores } from "../store/merchantStores";
import { awaitsAnswer, fetchActiveQueue, storesKey } from "../store/merchantQueue";
import { useResource } from "../lib/useResource";
import { useStoreResponseSecs } from "../lib/useStoreResponseSecs";
import { BottomNavLink } from "./BottomNavLink";

const POLL_MS = 15000;

/// The store side's bottom navigation, and its alert for orders waiting to
/// be accepted: a badge on Orders, and -- on any other screen -- a banner,
/// since an order not accepted within its window is cancelled. Re-read on
/// every new-order signal, and polled in case one was missed.
export function MerchantNav() {
  const stores = useMyStores();
  const windowSecs = useStoreResponseSecs();
  const { pathname } = useLocation();
  const { data } = useResource(
    stores && stores.length > 0 ? `merchant-waiting:${storesKey(stores)}` : null,
    async () => ({ rows: await fetchActiveQueue(stores ?? []), now: Date.now() }),
    { pollMs: POLL_MS, refreshOn: (signal) => "OrderPlaced" in signal },
  );
  const waiting = data && windowSecs !== undefined ? data.rows.filter((row) => awaitsAnswer(row, windowSecs, data.now)).length : 0;
  const onQueue = pathname === "/merchant";

  return (
    <>
      <AnimatePresence>
        {waiting > 0 && !onQueue && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="absolute inset-x-2 bottom-full mb-2"
          >
            <NavLink to="/merchant" className="flex items-center gap-3 rounded-2xl bg-relay-500 px-4 py-3 text-sm font-semibold text-white shadow-[var(--shadow-glow)]">
              <BellRing size={18} className="animate-pulse" />
              {waiting === 1 ? "1 new order is waiting for you" : `${waiting} new orders are waiting for you`}
              <span className="ml-auto text-xs font-bold uppercase tracking-wide">Review</span>
            </NavLink>
          </motion.div>
        )}
      </AnimatePresence>
      <BottomNavLink to="/merchant" icon={ClipboardList} label="Orders" badge={waiting} />
      <BottomNavLink to="/merchant/catalog" icon={Store} label="Menu" />
    </>
  );
}
