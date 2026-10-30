import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bike, ChefHat, ShoppingBag } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import clsx from "clsx";
import { primaryModeForRoles, useSession } from "../store/session";
import { Button, Card, Field, Input, Spinner, Textarea } from "../components/ui";
import { PhotoInput } from "../components/PhotoInput";
import { SplitAddressFields } from "../components/SplitAddressFields";
import { EMPTY_SPLIT_ADDRESS } from "../lib/places/splitAddress";
import { registerProviderCredential } from "../holochain/zomes/profiles";
import type { GeoPoint, RoleTag } from "../holochain/types";
import { fadeSlideUp, staggerContainer } from "../lib/ui/motion";
import { describeError } from "../lib/ui/errors";
import { DEV_ADMIN_URL } from "../lib/network/devNode";
import { HOST } from "../holochain/host";
import { DevIdentityPicker } from "../components/DevIdentityPicker";
import { RestoreAccount } from "../components/RestoreAccount";
import { isRestoring, rememberedMethod } from "../lib/account/restoring";
import { MAX_LABEL_CHARS, MAX_LICENSE_PLATE_CHARS, MAX_NOTE_CHARS, MAX_PHONE_CHARS, MAX_VEHICLE_CHARS } from "../holochain/types";
import { useT, type MessageKey } from "../i18n";

const ROLE_CARDS: { role: RoleTag; label: MessageKey; blurb: MessageKey; icon: typeof Bike }[] = [
  { role: "Requester", label: "onboarding.role.order", icon: ShoppingBag, blurb: "onboarding.role.orderBlurb" },
  { role: "Provider", label: "onboarding.role.deliver", icon: Bike, blurb: "onboarding.role.deliverBlurb" },
  { role: "Merchant", label: "onboarding.role.sell", icon: ChefHat, blurb: "onboarding.role.sellBlurb" },
];

const VEHICLE_TYPES: MessageKey[] = ["onboarding.vehicle.car", "onboarding.vehicle.bike", "onboarding.vehicle.scooter", "onboarding.vehicle.foot"];

type Step = "roles" | "details" | "vehicle" | "restore";
const STEP_ORDER: Step[] = ["roles", "details", "vehicle"];

export function Onboarding() {
  const navigate = useNavigate();
  const t = useT();
  const { createIdentity, reconnect, adoptIdentity, hasStoredIdentity, status, error, signOut } = useSession();
  // Only the dev host asks which node to provision on; the persistent dev
  // conductor always listens on the same address.
  const devHost = HOST === "dev";
  const [adminUrl, setAdminUrl] = useState(devHost ? DEV_ADMIN_URL : "");
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [phone, setPhone] = useState("");
  const [avatarDataUri, setAvatarDataUri] = useState("");
  const [location, setLocation] = useState<GeoPoint>(() => useSession.getState().location);
  // Presentation-only right now -- `Profile` (profiles_integrity) has no
  // address fields today, only `location` itself ever gets used (as the
  // session's default browse/dropoff point). Captured here anyway so this
  // screen matches the same split-address pattern every other "enter an
  // address" moment in the app uses -- see SplitAddressFields' own doc
  // comment. If a real saved mailing address for a customer/driver ever
  // becomes a product need, this is already sitting here ready to wire
  // into a Profile schema change.
  const [addressDraft, setAddressDraft] = useState(EMPTY_SPLIT_ADDRESS);
  const [roles, setRoles] = useState<RoleTag[]>(["Requester"]);
  // Part-way through bringing an account here (a reload while guardians
  // vouch): back to that, not to sign-up.
  // Part-way through bringing an account here: back to it. Receiving one
  // from another phone needs no key of this device's own, so no connection.
  const [step, setStep] = useState<Step>(() => (isRestoring() && (status === "connected" || rememberedMethod() === "device") ? "restore" : "roles"));
  const [localError, setLocalError] = useState<string | null>(null);

  const [vehicleType, setVehicleType] = useState(VEHICLE_TYPES[0]);
  const [vehicleDetail, setVehicleDetail] = useState("");
  const [licensePlate, setLicensePlate] = useState("");
  const [vehiclePhoto, setVehiclePhoto] = useState("");

  function toggleRole(role: RoleTag) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

  async function handleReconnect() {
    setLocalError(null);
    try {
      await reconnect();
      navigate("/");
    } catch (err) {
      // Most likely causes in dev: the conductor isn't running, or its
      // data was wiped (`npm run dev:reset`) since this identity was
      // created -- in which case this identity is gone for good and the
      // only way forward is to forget it.
      setLocalError(describeError(err));
    }
  }

  async function handleAdopt(installedAppId: string, agentPubKey: Uint8Array) {
    setLocalError(null);
    try {
      await adoptIdentity(adminUrl, installedAppId, agentPubKey);
      navigate("/");
    } catch (err) {
      setLocalError(describeError(err));
    }
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
      await createIdentity(displayName.trim(), roles, location, { bio, avatarDataUri, phone }, adminUrl);
      if (roles.includes("Provider")) {
        await registerProviderCredential({
          profile_action: useSession.getState().profileActionHash!,
          vehicle_description: `${t(vehicleType)}${vehicleDetail ? " · " + vehicleDetail : ""}`,
          capabilities: ["Food"],
          verified: false,
          license_plate: licensePlate,
          photo_data_uri: vehiclePhoto,
        });
      }
      const primary = primaryModeForRoles(roles);
      navigate(`/${primary}`);
    } catch (err) {
      setLocalError(describeError(err));
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
          {t("onboarding.tagline")}
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-sm"
      >
        <Card className="bg-white text-ink-900 p-6 overflow-hidden">
          {step === "restore" ? (
            <RestoreAccount devAdminUrl={adminUrl} onBack={() => setStep("roles")} onDone={() => navigate("/")} />
          ) : (
          <>
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
                <h2 className="text-lg font-bold mb-1">{t("onboarding.what")}</h2>
                <p className="text-sm text-ink-500 mb-4">{t("onboarding.pick")}</p>
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
                          <p className="font-semibold text-sm">{t(label)}</p>
                          <p className="text-xs text-ink-500">{t(blurb)}</p>
                        </div>
                      </motion.button>
                    );
                  })}
                </motion.div>
                <Button className="w-full" disabled={roles.length === 0} onClick={() => setStep("details")}>
                  {t("common.continue")}
                </Button>
                <button type="button" onClick={() => setStep("restore")} className="mt-3 w-full text-center text-sm font-semibold text-relay-600 hover:underline">
                  {t("onboarding.haveAccount")}
                </button>
              </motion.div>
            )}

            {step === "details" && (
              <motion.div key="details" variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0 }}>
                <h2 className="text-lg font-bold mb-1">{t("onboarding.create")}</h2>
                <p className="text-sm text-ink-500 mb-4">{t("onboarding.createDetail")}</p>

                <div className="mb-4 flex justify-center">
                  <PhotoInput value={avatarDataUri} onChange={setAvatarDataUri} shape="circle" />
                </div>

                <Field label={t("onboarding.name")} className="mb-4">
                  <Input maxLength={MAX_LABEL_CHARS} autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t("onboarding.namePlaceholder")} />
                  <p className="mt-1 text-[11px] text-ink-400">
                    {roles.some((r) => r !== "Requester") ? t("onboarding.namePublic") : t("onboarding.namePrivate")}
                  </p>
                </Field>
                <Field label={t("onboarding.bio")} className="mb-4">
                  <Textarea maxLength={MAX_NOTE_CHARS} value={bio} onChange={(e) => setBio(e.target.value)} rows={2} placeholder={t("onboarding.bioPlaceholder")} />
                </Field>
                <Field label={t("onboarding.phone")} className="mb-4">
                  <Input maxLength={MAX_PHONE_CHARS} value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" />
                </Field>
                {/* Same shared SplitAddressFields every other "enter an
                    address" moment in the app uses (merchant storefront
                    publish/edit) -- see this component's and
                    addressDraft's own doc comments for why the split
                    fields here are presentation-only for now. */}
                <div className="mb-4 flex flex-col gap-2">
                  <SplitAddressFields
                    point={location}
                    onPointChange={setLocation}
                    address={addressDraft}
                    onAddressChange={setAddressDraft}
                    streetLabel={t("onboarding.location")}
                  />
                </div>
                {devHost && (
                  <>
                    <div className="mb-1">
                      <label className="block text-xs font-semibold text-ink-500 mb-1">Local node address</label>
                      <Input value={adminUrl} onChange={(e) => setAdminUrl(e.target.value)} placeholder="ws://localhost:XXXXX/" className="font-mono" />
                    </div>
                    <p className="text-[11px] text-ink-400 mb-4">
                      Run <code className="bg-ink-100 rounded px-1">npm run dev:conductor</code> in another terminal (from{" "}
                      <code className="bg-ink-100 rounded px-1">web/</code>). It starts a local node that keeps its data between restarts, always at this address.
                    </p>
                  </>
                )}

                {showError && (
                  <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                    {showError}
                  </motion.p>
                )}

                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setStep("roles")} disabled={connecting}>
                    {t("common.back")}
                  </Button>
                  <Button className="flex-1" onClick={goToDetailsNext} disabled={connecting || !displayName.trim() || (devHost && !adminUrl.trim())}>
                    {connecting ? <Spinner className="h-4 w-4" /> : roles.includes("Provider") ? t("onboarding.nextVehicle") : t("onboarding.enter")}
                  </Button>
                </div>
              </motion.div>
            )}

            {step === "vehicle" && (
              <motion.div key="vehicle" variants={fadeSlideUp} initial="hidden" animate="visible" exit={{ opacity: 0 }}>
                <h2 className="text-lg font-bold mb-1">{t("onboarding.vehicle")}</h2>
                <p className="text-sm text-ink-500 mb-4">{t("onboarding.vehicleDetail")}</p>

                <div className="mb-4">
                  <PhotoInput value={vehiclePhoto} onChange={setVehiclePhoto} shape="banner" />
                </div>

                <label className="block text-xs font-semibold text-ink-500 mb-1">{t("onboarding.vehicleType")}</label>
                <div className="mb-4 flex flex-wrap gap-2">
                  {VEHICLE_TYPES.map((type) => (
                    <button
                      key={type}
                      onClick={() => setVehicleType(type)}
                      className={clsx(
                        "rounded-full px-3 py-1.5 text-xs font-semibold transition",
                        vehicleType === type ? "bg-relay-500 text-white" : "bg-ink-100 text-ink-500 hover:bg-ink-200"
                      )}
                    >
                      {t(type)}
                    </button>
                  ))}
                </div>
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-ink-500 mb-1">{t("onboarding.makeModel")}</label>
                  <Input maxLength={MAX_VEHICLE_CHARS} value={vehicleDetail} onChange={(e) => setVehicleDetail(e.target.value)} placeholder={t("onboarding.makeModelPlaceholder")} />
                </div>
                <div className="mb-4">
                  <label className="block text-xs font-semibold text-ink-500 mb-1">{t("onboarding.plate")}</label>
                  <Input maxLength={MAX_LICENSE_PLATE_CHARS} value={licensePlate} onChange={(e) => setLicensePlate(e.target.value)} className="font-mono" />
                </div>

                {showError && (
                  <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                    {showError}
                  </motion.p>
                )}

                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setStep("details")} disabled={connecting}>
                    {t("common.back")}
                  </Button>
                  <Button className="flex-1" onClick={finish} disabled={connecting}>
                    {connecting ? <Spinner className="h-4 w-4" /> : t("onboarding.enter")}
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          </>
          )}

          {devHost && step === "roles" && <DevIdentityPicker adminUrl={adminUrl} onPick={handleAdopt} disabled={connecting} />}

          {devHost && hasStoredIdentity() && step === "roles" && (
            <div className="mt-4">
              <button onClick={handleReconnect} disabled={connecting} className="w-full text-center text-xs font-semibold text-relay-600 hover:underline">
                {connecting ? "Reconnecting..." : "Continue as your existing identity"}
              </button>
              {showError && (
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                  <p>{showError}</p>
                  <p className="mt-1.5 text-[11px] text-red-600">
                    Either your local node isn't running (start it with <code>npm run dev:conductor</code>), or its data was reset since this identity was created, in which case it can't be recovered.{" "}
                    <button onClick={signOut} className="font-semibold underline">
                      Forget it and start over
                    </button>
                  </p>
                </motion.div>
              )}
            </div>
          )}
        </Card>
      </motion.div>
    </div>
  );
}
