import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useSession } from "./store/session";
import { Spinner } from "./components/ui";
import { AppShell } from "./components/AppShell";
import { Onboarding } from "./routes/Onboarding";
import { Browse } from "./routes/customer/Browse";
import { MerchantDetail } from "./routes/customer/MerchantDetail";
import { Cart } from "./routes/customer/Cart";
import { Orders } from "./routes/customer/Orders";
import { OrderDetail } from "./routes/customer/OrderDetail";
import { DriverDashboard } from "./routes/driver/Dashboard";
import { Earnings } from "./routes/driver/Earnings";
import { MerchantOrders } from "./routes/merchant/Orders";
import { MerchantCatalog } from "./routes/merchant/Catalog";
import { ProfilePage } from "./routes/Profile";
import { Transparency } from "./routes/Transparency";
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
/// Retries a couple of times with a short backoff before giving up --
/// confirmed directly (not hypothetical) that a single reconnect attempt
/// can transiently fail under real concurrent load against the conductor
/// (the same "database is locked" contention already named elsewhere in
/// this project's own test harness, self-resolving within a second or
/// two). Without a retry here, a real user would hit that exact transient
/// blip and get bounced all the way to the full onboarding screen --
/// reading as "I lost my account" for what's actually a passing hiccup.
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
        } catch {
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

export default function App() {
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
          <Route path="/driver" element={<DriverDashboard />} />
          <Route path="/driver/earnings" element={<Earnings />} />
          <Route path="/merchant" element={<MerchantOrders />} />
          <Route path="/merchant/catalog" element={<MerchantCatalog />} />
          <Route path="/arbitrator" element={<ArbitratorDashboard />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/transparency" element={<Transparency />} />
          <Route path="*" element={<HomeForMode />} />
        </Route>
      </Routes>
    </SessionBootstrap>
  );
}
