import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useSession } from "./store/session";
import { HOST } from "./holochain/host";
import { Spinner } from "./components/ui";
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
import { MerchantOrders } from "./routes/merchant/Orders";
import { MerchantCatalog } from "./routes/merchant/Catalog";
import { NewStore } from "./routes/merchant/NewStore";
import { ProfilePage } from "./routes/Profile";
import { Transparency } from "./routes/Transparency";
import { Policies } from "./routes/Policies";
import { ArbitratorDashboard } from "./routes/arbitrator/Dashboard";

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

function SessionBootstrap({ children }: { children: React.ReactNode }) {
  const { status, hasStoredIdentity, reconnect } = useSession();
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    async function attemptReconnect() {
      for (let i = 0; i < RECONNECT_RETRIES; i++) {
        try {
          await reconnect();
          return;
        } catch (err) {
          // A passkey ceremony is user-interactive and can itself take up
          // to a minute (session.ts's reconnect() tags this distinctly) --
          // retrying it automatically just re-triggers Touch ID/Windows
          // Hello 2-3 more times back to back, which is what was reading
          // as the page freezing/crashing on refresh, not a helpful retry.
          // Only the *other* (transient-infra) failures get retried.
          if (err instanceof Error && err.name === "PasskeyError") return;
          if (i < RECONNECT_RETRIES - 1) await new Promise((r) => setTimeout(r, RECONNECT_RETRY_DELAY_MS));
        }
      }
    }
    if (hasStoredIdentity() && status === "disconnected") {
      attemptReconnect().finally(() => setAttempted(true));
    } else {
      setAttempted(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

function RequireSession({ children }: { children: React.ReactNode }) {
  const status = useSession((s) => s.status);
  const profile = useSession((s) => s.profile);
  if (status !== "connected" || !profile) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function HomeForMode() {
  const mode = useSession((s) => s.mode);
  return <Navigate to={mode === "driver" ? "/driver" : mode === "merchant" ? "/merchant" : mode === "arbitrator" ? "/arbitrator" : "/customer"} replace />;
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
  if (HOST === "none") return <NoHost />;
  return (
    <SessionBootstrap>
      <Routes>
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
          <Route path="/arbitrator" element={<ArbitratorDashboard />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/transparency" element={<Transparency />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="*" element={<HomeForMode />} />
        </Route>
      </Routes>
    </SessionBootstrap>
  );
}
