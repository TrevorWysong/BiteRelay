import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import { Home, ClipboardList, ShoppingCart, User, Car, DollarSign } from "lucide-react";
import { useSession, type Mode } from "../store/session";
import { useCart } from "../store/cart";
import { pageVariants } from "../lib/motion";
import { PresenceDot } from "./ui";
import { BottomNavLink } from "./BottomNavLink";
import { MerchantNav } from "./MerchantNav";
import { Notifier } from "./Notifier";
import { ConnectionBanner } from "./ConnectionBanner";
import { usePolling } from "../lib/useResource";
import { POLL } from "../lib/poll";
import { collectIncoming } from "../lib/wallet";

/// Wraps whichever route is active in a short fade+rise so navigating
/// between screens (Browse -> cart, an order's detail page, switching
/// modes) feels like one continuous app rather than a hard page swap --
/// `mode="wait"` so the outgoing screen finishes leaving before the next
/// one enters, `initial={false}` so the very first screen on load doesn't
/// also play the enter animation (it's already there).
function AnimatedOutlet() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={location.pathname} variants={pageVariants} initial="initial" animate="animate" exit="exit">
        <Outlet />
      </motion.div>
    </AnimatePresence>
  );
}

export function AppShell() {
  const { mode, setMode, profile, agentPubKey } = useSession();
  const cartCount = useCart((s) => s.lines.reduce((n, l) => n + l.quantity, 0));
  const navigate = useNavigate();
  const roles = profile?.roles ?? [];
  // Funds an issuer added, and cash-outs it declined, land in the balance
  // without anyone having to open the wallet.
  usePolling(() => collectIncoming().catch(() => 0), { pollMs: POLL.unsignalled * 4 }, !!agentPubKey);

  const availableModes = [
    roles.includes("Requester") && ("customer" as const),
    roles.includes("Provider") && ("driver" as const),
    roles.includes("Merchant") && ("merchant" as const),
  ].filter(Boolean) as Mode[];

  function switchMode(next: Mode) {
    setMode(next);
    navigate(`/${next}`);
  }

  return (
    <div className="mx-auto flex min-h-svh max-w-md flex-col bg-ink-50 dark:bg-ink-950">
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-ink-100 dark:border-ink-800 bg-white/90 dark:bg-ink-900/80 backdrop-blur px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-relay-500 text-white font-black text-sm">R</div>
          <span className="font-black text-lg tracking-tight">Relay</span>
        </div>
        <div className="flex items-center gap-2">
          {availableModes.length > 1 && (
            <div className="flex items-center rounded-full bg-ink-100 dark:bg-ink-800 p-1 text-xs font-semibold">
              {availableModes.map((m) => (
                <button
                  key={m}
                  onClick={() => switchMode(m)}
                  className={clsx(
                    "rounded-full px-2.5 py-1 transition capitalize",
                    mode === m ? "bg-white dark:bg-ink-950 shadow-sm text-ink-900 dark:text-white" : "text-ink-400"
                  )}
                >
                  {m === "customer" ? "Order" : m === "driver" ? "Drive" : "Sell"}
                </button>
              ))}
            </div>
          )}
          <NavLink to="/profile" className="flex h-9 w-9 items-center justify-center rounded-full bg-ink-100 dark:bg-ink-800">
            <User size={18} />
          </NavLink>
        </div>
      </header>

      <Notifier />
      <ConnectionBanner />
      <main className="flex-1 overflow-y-auto pb-20">
        <AnimatedOutlet />
      </main>

      <nav className="fixed bottom-0 left-1/2 z-20 flex w-full max-w-md -translate-x-1/2 border-t border-ink-100 dark:border-ink-800 bg-white/95 dark:bg-ink-900/95 backdrop-blur px-2 pb-[env(safe-area-inset-bottom)]">
        {mode === "customer" && (
          <>
            <BottomNavLink to="/customer" icon={Home} label="Browse" />
            <BottomNavLink to="/customer/cart" icon={ShoppingCart} label="Cart" badge={cartCount} />
            <BottomNavLink to="/customer/orders" icon={ClipboardList} label="Orders" />
          </>
        )}
        {mode === "driver" && (
          <>
            <BottomNavLink to="/driver" icon={Car} label="Dash" />
            <BottomNavLink to="/driver/earnings" icon={DollarSign} label="Earnings" />
          </>
        )}
        {mode === "merchant" && <MerchantNav />}
      </nav>

      {agentPubKey && (
        <div className="fixed left-2 top-2 z-30 hidden items-center gap-1 rounded-full bg-black/70 px-2 py-1 text-[10px] text-white lg:flex">
          <PresenceDot />
          connected
        </div>
      )}
    </div>
  );
}
