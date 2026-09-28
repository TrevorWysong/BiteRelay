import { Navigate, Route, Routes } from "react-router-dom";
import { useSession } from "./store/session";
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
import { ArbitratorDashboard } from "./routes/arbitrator/Dashboard";

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
        <Route path="*" element={<HomeForMode />} />
      </Route>
    </Routes>
  );
}
