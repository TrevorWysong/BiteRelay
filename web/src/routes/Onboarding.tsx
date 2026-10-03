import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bike, ChefHat, ShoppingBag } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { useSession } from "../store/session";
import { Button, Card, Input, Spinner, Textarea } from "../components/ui";
import { PhotoInput } from "../components/PhotoInput";
import { registerProviderCredential } from "../holochain/zomes/profiles";
import type { RoleTag } from "../holochain/types";
import { fadeSlideUp, staggerContainer } from "../lib/motion";

const ROLE_CARDS: { role: RoleTag; label: string; blurb: string; icon: typeof Bike }[] = [
  { role: "Requester", label: "Order food", icon: ShoppingBag, blurb: "Browse nearby restaurants and get food delivered." },
  { role: "Provider", label: "Deliver", icon: Bike, blurb: "Go online, pick up nearby orders, earn on your own schedule." },
  { role: "Merchant", label: "Sell food", icon: ChefHat, blurb: "Publish a menu and take orders from nearby customers." },
];

const VEHICLE_TYPES = ["Car", "Bike", "Scooter", "On foot"];

type Step = "roles" | "details" | "vehicle";
const STEP_ORDER: Step[] = ["roles", "details", "vehicle"];

export function Onboarding() {
  const navigate = useNavigate();
  const { createIdentity, reconnect, hasStoredIdentity, status, error } = useSession();
  const [adminUrl, setAdminUrl] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [phone, setPhone] = useState("");
  const [avatarDataUri, setAvatarDataUri] = useState("");
  const [roles, setRoles] = useState<RoleTag[]>(["Requester"]);
  const [step, setStep] = useState<Step>("roles");
  const [localError, setLocalError] = useState<string | null>(null);

  const [vehicleType, setVehicleType] = useState(VEHICLE_TYPES[0]);
  const [vehicleDetail, setVehicleDetail] = useState("");
  const [licensePlate, setLicensePlate] = useState("");
  const [vehiclePhoto, setVehiclePhoto] = useState("");

  function toggleRole(role: RoleTag) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

  async function handleReconnect() {
    await reconnect();
    navigate("/");
  }

  function goToDetailsNext() {
    if (!displayName.trim()) return;
    if (roles.includes("Provider")) {
      setStep("vehicle");
    } else {
      void finish();
    }
  }

  async function finish() {
    setLocalError(null);
    try {
      await createIdentity(adminUrl, displayName.trim(), roles, { lat: 27.7676, lon: -82.6403 }, { bio, avatarDataUri, phone });
      if (roles.includes("Provider")) {
        await registerProviderCredential({
          profile_action: useSession.getState().profileActionHash!,
          vehicle_description: `${vehicleType}${vehicleDetail ? " · " + vehicleDetail : ""}`,
          capabilities: ["Food"],
          verified: false,
          license_plate: licensePlate,
          photo_data_uri: vehiclePhoto,
        });
      }
      const primary = roles.includes("Requester") ? "customer" : roles.includes("Provider") ? "driver" : "merchant";
      navigate(`/${primary}`);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  }

  const connecting = status === "connecting";
  const showError = error || localError;
  const stepIndex = STEP_ORDER.indexOf(step);
  const totalSteps = roles.includes("Provider") ? 3 : 2;

  return (
    <div className="mesh-hero flex min-h-svh flex-col items-center justify-center px-6 py-10 text-white">
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="mb-8 flex flex-col items-center gap-3"
      >
        <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-white text-relay-600 font-black text-3xl shadow-xl">R</div>
        <h1 className="text-3xl font-black tracking-tight">Relay</h1>
        <p className="text-white/80 text-sm text-center max-w-xs">
          A peer-to-peer delivery marketplace with no corporate middleman and no central server. Orders run directly between you and the people fulfilling them.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-sm"
      >
        <Card className="bg-white text-ink-900 p-6 overflow-hidden">
          <div className="mb-5 flex items-center gap-1.5">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <motion.div
                key={i}
                className="h-1.5 flex-1 rounded-full bg-ink-100"
                animate={{ backgroundColor: i <= stepIndex ? "#ff5a2b" : "#ece9e6" }}
                transition={{ duration: 0.25 }}
              />
            ))}
          </div>

          <AnimatePresence mode="wait" initial={false}>
            {step === "roles" && (
              <motion.div key="roles" variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0 }}>
                <h2 className="text-lg font-bold mb-1">What do you want to do?</h2>
                <p className="text-sm text-ink-500 mb-4">Pick one or more. You can switch anytime.</p>
                <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="flex flex-col gap-2 mb-5">
                  {ROLE_CARDS.map(({ role, label, blurb, icon: Icon }) => {
                    const active = roles.includes(role);
                    return (
                      <motion.button
                        key={role}
                        variants={fadeSlideUp}
                        onClick={() => toggleRole(role)}
                        whileTap={{ scale: 0.98 }}
                        className={clsx(
                          "flex items-center gap-3 rounded-xl border-2 p-3 text-left transition",
                          active ? "border-relay-500 bg-relay-50" : "border-ink-100 hover:border-ink-200"
                        )}
                      >
                        <motion.div
                          animate={{ scale: active ? 1.06 : 1 }}
                          transition={{ duration: 0.2 }}
                          className={clsx("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", active ? "bg-relay-500 text-white" : "bg-ink-100 text-ink-400")}
                        >
                          <Icon size={18} />
                        </motion.div>
                        <div>
                          <p className="font-semibold text-sm">{label}</p>
                          <p className="text-xs text-ink-500">{blurb}</p>
                        </div>
                      </motion.button>
                    );
                  })}
                </motion.div>
                <Button className="w-full" disabled={roles.length === 0} onClick={() => setStep("details")}>
                  Continue
                </Button>
              </motion.div>
            )}

            {step === "details" && (
              <motion.div key="details" variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0 }}>
                <h2 className="text-lg font-bold mb-1">Create your identity</h2>
                <p className="text-sm text-ink-500 mb-4">
                  This creates your own private identity, secured by a cryptographic key that only you hold. It's not an account on a shared server.
                </p>

                <div className="mb-4 flex justify-center">
                  <PhotoInput value={avatarDataUri} onChange={setAvatarDataUri} shape="circle" />
                </div>

                <div className="mb-4">
                  <label className="block text-xs font-semibold text-ink-500 mb-1">Display name</label>
                  <Input autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Alex Rivera" />
                </div>
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-ink-500 mb-1">Bio (optional)</label>
                  <Textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={2} placeholder="A little about you" />
                </div>
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-ink-500 mb-1">Phone (optional)</label>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 555-0100" />
                </div>
                <div className="mb-1">
                  <label className="block text-xs font-semibold text-ink-500 mb-1">Local node address</label>
                  <Input value={adminUrl} onChange={(e) => setAdminUrl(e.target.value)} placeholder="ws://localhost:XXXXX/" className="font-mono" />
                </div>
                <p className="text-[11px] text-ink-400 mb-4">
                  Run <code className="bg-ink-100 rounded px-1">npm run dev:conductor</code> in another terminal (from{" "}
                  <code className="bg-ink-100 rounded px-1">web/</code>). This starts a local test node and gives you this address.
                </p>

                {showError && (
                  <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                    {showError}
                  </motion.p>
                )}

                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setStep("roles")} disabled={connecting}>
                    Back
                  </Button>
                  <Button className="flex-1" onClick={goToDetailsNext} disabled={connecting || !displayName.trim() || !adminUrl.trim()}>
                    {connecting ? <Spinner className="h-4 w-4" /> : roles.includes("Provider") ? "Next: vehicle info" : "Enter Relay"}
                  </Button>
                </div>
              </motion.div>
            )}

            {step === "vehicle" && (
              <motion.div key="vehicle" variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0 }}>
                <h2 className="text-lg font-bold mb-1">Your vehicle</h2>
                <p className="text-sm text-ink-500 mb-4">Shown to customers once you're assigned their delivery.</p>

                <div className="mb-4 flex justify-center">
                  <PhotoInput value={vehiclePhoto} onChange={setVehiclePhoto} shape="banner" />
                </div>

                <label className="block text-xs font-semibold text-ink-500 mb-1">Vehicle type</label>
                <div className="mb-4 flex flex-wrap gap-2">
                  {VEHICLE_TYPES.map((t) => (
                    <button
                      key={t}
                      onClick={() => setVehicleType(t)}
                      className={clsx(
                        "rounded-full px-3 py-1.5 text-xs font-semibold transition",
                        vehicleType === t ? "bg-relay-500 text-white" : "bg-ink-100 text-ink-500 hover:bg-ink-200"
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-ink-500 mb-1">Make / model / color (optional)</label>
                  <Input value={vehicleDetail} onChange={(e) => setVehicleDetail(e.target.value)} placeholder="Blue Honda Civic" />
                </div>
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-ink-500 mb-1">License plate (optional)</label>
                  <Input value={licensePlate} onChange={(e) => setLicensePlate(e.target.value)} placeholder="ABC-1234" className="font-mono" />
                </div>

                {showError && (
                  <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                    {showError}
                  </motion.p>
                )}

                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setStep("details")} disabled={connecting}>
                    Back
                  </Button>
                  <Button className="flex-1" onClick={finish} disabled={connecting}>
                    {connecting ? <Spinner className="h-4 w-4" /> : "Enter Relay"}
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {hasStoredIdentity() && step === "roles" && (
            <button onClick={handleReconnect} disabled={connecting} className="mt-4 w-full text-center text-xs font-semibold text-relay-600 hover:underline">
              {connecting ? "Reconnecting..." : "Continue as your existing identity"}
            </button>
          )}
        </Card>
      </motion.div>
    </div>
  );
}
