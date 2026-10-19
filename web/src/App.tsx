import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useSession } from "./store/session";
import { HOST } from "./holochain/host";
import { Spinner } from "./components/ui";
import { Fingerprint } from "lucide-react";
import { describeError } from "./lib/errors";
import { AppShell } from "./components/AppShell";
import { Onboarding } from "./routes/Onboarding";
import { Browse } from "./routes/customer/Browse";
import { MerchantDetail } from "./routes/customer/MerchantDetail";
import { Cart } from "./routes/customer/Cart";
import { Orders } from "./routes/customer/Orders";
import { OrderDetail } from "./routes/customer/OrderDetail";
import { PickupOrderDetail } from "./routes/customer/PickupOrderDetail";
import { DriverDashboard } from "./routes/driver/Dashboard";
import { Earnings } from "./routes/driver/Earnings";
import { Wallet } from "./routes/Wallet";
import { MerchantOrders } from "./routes/merchant/Orders";
import { MerchantCatalog } from "./routes/merchant/Catalog";
import { NewStore } from "./routes/merchant/NewStore";
import { ProfilePage } from "./routes/Profile";
import { Transparency } from "./routes/Transparency";
import { Policies } from "./routes/Policies";
import { AccountPage } from "./routes/Account";
import VerifyPage from "./routes/Verify";
import ArbitratePage from "./routes/Arbitrate";
import { useLocale } from "./i18n";
import { MovedAway } from "./components/MovedAway";

/// Every fresh page load starts `status: "disconnected"`, regardless of
/// whether a real identity is already provisioned on the conductor and
/// sitting in localStorage -- without this, `RequireSession` below would
/// bounce straight to the full onboarding screen on every browser refresh
/// (or PWA relaunch), forcing a manual "Continue as your existing
/// identity" click every single time. Attempting a silent reconnect once,
/// before the route tree ever renders Onboarding, is what makes "closing
/// and reopening the app" actually feel like a persistent session instead
/// of a repeated login prompt. A failed/absent reconnect still falls
/// through to the normal onboarding flow, unchanged.
///
/// Retries a few times with a short backoff: under load a reconnect can
/// fail transiently (the conductor's "database is locked" contention clears
/// within a second or two), and giving up at once would bounce a returning
/// user to onboarding -- which reads as a lost account.
const RECONNECT_RETRIES = 3;
const RECONNECT_RETRY_DELAY_MS = 1200;

/// Failures not worth retrying: a passkey ceremony (user-interactive --
/// retrying re-prompts Touch ID back to back), and an identity the node no
/// longer has (a dev reset wiped it).
const FINAL_FAILURES = new Set(["PasskeyError", "IdentityGone"]);

function SessionBootstrap({ children }: { children: React.ReactNode }) {
  const { status, hasStoredIdentity, needsUnlock, reconnect } = useSession();
  const [attempted, setAttempted] = useState(false);
  // A passkey-locked identity waits for a tap: a prompt on page load is
  // one Safari refuses or stalls on.
  const [locked, setLocked] = useState(() => status === "disconnected" && hasStoredIdentity() && needsUnlock());

  useEffect(() => {
    async function attemptReconnect() {
      for (let i = 0; i < RECONNECT_RETRIES; i++) {
        try {
          await reconnect();
          return;
        } catch (err) {
          if (err instanceof Error && FINAL_FAILURES.has(err.name)) return;
          if (i < RECONNECT_RETRIES - 1) await new Promise((r) => setTimeout(r, RECONNECT_RETRY_DELAY_MS));
        }
      }
    }
    if (hasStoredIdentity() && status === "disconnected" && !needsUnlock()) {
      attemptReconnect().finally(() => setAttempted(true));
    } else {
      setAttempted(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (locked) return <UnlockScreen onDone={() => setLocked(false)} />;
  if (!attempted) {
    return (
      <div className="mesh-hero flex min-h-svh flex-col items-center justify-center gap-3 text-white">
        <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-white text-relay-600 font-black text-3xl shadow-xl">R</div>
        <Spinner className="h-6 w-6" />
        {/* A device-locked identity's reconnect can legitimately sit here
            up to a minute waiting on a Touch ID/Windows Hello prompt (an
            OS-level UI this page can't show anything about directly) --
            an unlabeled spinner for that long reads as a frozen page. */}
        <p className="text-xs text-white/70">Reconnecting -- check for a sign-in prompt if this takes a moment</p>
      </div>
    );
  }
  return <>{children}</>;
}

/// A remembered identity behind a passkey: unlocked by a tap, which is when
/// the browser shows Touch ID or Windows Hello. "Another way" goes to
/// sign-in, which can still continue as this identity.
function UnlockScreen({ onDone }: { onDone: () => void }) {
  const reconnect = useSession((s) => s.reconnect);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      await reconnect();
      onDone();
    } catch (err) {
      // Gone for good (a dev reset): nothing to unlock -- on to sign-in.
      if (err instanceof Error && err.name === "IdentityGone") onDone();
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <div className="mesh-hero flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-white">
      <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-white text-3xl font-black text-relay-600 shadow-xl">R</div>
      <p className="text-lg font-bold">Welcome back</p>
      <button onClick={unlock} disabled={busy} className="flex items-center gap-2 rounded-full bg-white px-6 py-3 font-semibold text-relay-600 shadow-lg disabled:opacity-60">
        {busy ? <Spinner className="h-4 w-4" /> : <Fingerprint size={18} />} Unlock Relay
      </button>
      {error && <p className="max-w-xs text-center text-xs text-white/80">{error}</p>}
      <button onClick={onDone} className="text-xs text-white/70 underline underline-offset-2">
        Sign in another way
      </button>
    </div>
  );
}

function RequireSession({ children }: { children: React.ReactNode }) {
  const status = useSession((s) => s.status);
  const profile = useSession((s) => s.profile);
  const movedTo = useSession((s) => s.movedTo);
  const movedToNewVersion = useSession((s) => s.movedToNewVersion);
  if (status === "connected" && movedToNewVersion) return <MovedAway to={null} />;
  if (status === "connected" && movedTo) return <MovedAway to={movedTo} />;
  if (status !== "connected" || !profile) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function HomeForMode() {
  const mode = useSession((s) => s.mode);
  return <Navigate to={mode === "driver" ? "/driver" : mode === "merchant" ? "/merchant" : "/customer"} replace />;
}

/// A production build opened in a plain browser: there's no conductor here
/// to talk to -- Relay runs inside its own app (see holochain/host.ts).
function NoHost() {
  return (
    <div className="mesh-hero flex min-h-svh flex-col items-center justify-center gap-4 px-8 text-center text-white">
      <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-white text-relay-600 font-black text-3xl shadow-xl">R</div>
      <h1 className="text-xl font-black">Open Relay in the Relay app</h1>
      <p className="max-w-sm text-sm text-white/80">
        Relay has no servers: it runs on your own device, in the Relay app, which keeps your identity and data with you. This page can't reach it from a browser.
      </p>
    </div>
  );
}

export default function App() {
  // A change of language remounts the screens, so every word -- including
  // those a screen computed once -- is read again in the new one.
  const locale = useLocale((s) => s.locale);
  if (HOST === "none") return <NoHost />;
  return (
    <SessionBootstrap>
      <Routes key={locale}>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route
          element={
            <RequireSession>
              <AppShell />
            </RequireSession>
          }
        >
          <Route path="/" element={<HomeForMode />} />
          <Route path="/customer" element={<Browse />} />
          <Route path="/customer/merchant/:hash" element={<MerchantDetail />} />
          <Route path="/customer/cart" element={<Cart />} />
          <Route path="/customer/orders" element={<Orders />} />
          <Route path="/customer/orders/:hash" element={<OrderDetail />} />
          <Route path="/customer/pickup-orders/:hash" element={<PickupOrderDetail />} />
          <Route path="/driver" element={<DriverDashboard />} />
          <Route path="/driver/earnings" element={<Earnings />} />
          <Route path="/merchant" element={<MerchantOrders />} />
          <Route path="/merchant/catalog" element={<MerchantCatalog />} />
          <Route path="/merchant/stores/new" element={<NewStore />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/transparency" element={<Transparency />} />
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/verify" element={<VerifyPage />} />
          <Route path="/arbitrate" element={<ArbitratePage />} />
          <Route path="*" element={<HomeForMode />} />
        </Route>
      </Routes>
    </SessionBootstrap>
  );
}
