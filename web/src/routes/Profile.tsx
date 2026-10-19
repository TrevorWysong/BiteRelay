import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronRight, Fingerprint, KeyRound, LogOut, Pencil, Radio, ShieldCheck, Store, Truck } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { encodeHashToBase64 } from "@holochain/client";
import { useSession } from "../store/session";
import { useMerchantStores, useMyStores } from "../store/merchantStores";
import { useResource } from "../lib/useResource";
import { getBalance } from "../holochain/zomes/ledger";
import { averageRating, getRatingSummary, getReputationSummary, getReviewsFor } from "../holochain/zomes/reputation";
import { updateProfile, getMyName, getMyPhone, getProviderCredentialForProfile, registerProviderCredential } from "../holochain/zomes/profiles";
import { bytesToHex, decodeEntry } from "../holochain/decode";
import { Button, Card, Input, Skeleton, StatNumber, Textarea } from "../components/ui";
import { PhotoInput } from "../components/PhotoInput";
import { StarRating } from "../components/StarRating";
import { formatCents } from "../lib/format";
import { fadeSlideUp, staggerContainer } from "../lib/motion";
import { describeError } from "../lib/errors";
import type { ProviderCredential, RatingSummary, Review } from "../holochain/types";
import { HOST } from "../holochain/host";
import { NotificationSettings } from "../components/NotificationSettings";
import { LanguagePicker } from "../components/LanguagePicker";
import { DevIdentityPicker } from "../components/DevIdentityPicker";
import { DEV_ADMIN_URL } from "../lib/devNode";
import { MAX_LABEL_CHARS, MAX_LICENSE_PLATE_CHARS, MAX_NOTE_CHARS, MAX_PHONE_CHARS, MAX_VEHICLE_CHARS } from "../holochain/types";
import { useT } from "../i18n";

/// One identity, several hats: ratings and stats are shown per role (your
/// driving) and per store (each restaurant you run), never blended into
/// one agent-wide number -- see `reputation_integrity`'s module doc.
export function ProfilePage() {
  const navigate = useNavigate();
  const t = useT();
  const { profile, profileActionHash, agentPubKey, hasDeviceLock, signOut, refreshProfile, setMode, adoptIdentity } = useSession();
  const setActiveStore = useMerchantStores((s) => s.setActive);
  const isDriver = !!profile?.roles.includes("Provider");
  const isMerchant = !!profile?.roles.includes("Merchant");
  const stores = useMyStores(isMerchant);
  const agentHex = agentPubKey ? bytesToHex(agentPubKey) : null;
  const { data: balance } = useResource(agentHex && `balance:${agentHex}`, () => getBalance(agentPubKey!));
  // The phone is sealed to its owner, so it's read through the zome.
  const { data: phone = null, reload: reloadPhone } = useResource(agentHex && `phone:${agentHex}`, getMyPhone);
  const { data: myName = null, reload: reloadName } = useResource(agentHex && `name:${agentHex}`, getMyName);
  // A store or driver's name is public; a customer's goes only to the
  // store and driver of each order.
  const publicFacing = isDriver || isMerchant;
  // Driver-scoped stats -- `null` key (no read at all) unless this
  // identity actually drives.
  const driverKey = agentHex && isDriver ? `driver:${agentHex}` : null;
  const { data: rep } = useResource(driverKey && `${driverKey}:rep`, () => getReputationSummary({ Driver: agentPubKey! }));
  const { data: driverRating } = useResource(driverKey && `${driverKey}:rating`, () => getRatingSummary({ Driver: agentPubKey! }));
  const { data: reviews = [] } = useResource<Review[]>(driverKey && `${driverKey}:reviews`, () =>
    getReviewsFor({ Driver: agentPubKey! }).then((page) => page.reviews.map((r) => decodeEntry<Review>(r))),
  );
  // Keyed by the exact set of stores, so adding a store re-reads ratings.
  const storeHexes = stores?.map((s) => s.hex).join(",") ?? "";
  const { data: storeRatings = {} } = useResource<Record<string, RatingSummary>>(storeHexes ? `store-ratings:${storeHexes}` : null, async () => {
    const entries = await Promise.all((stores ?? []).map(async (store) => [store.hex, await getRatingSummary({ Store: store.hash })] as const));
    return Object.fromEntries(entries);
  });
  const credentialKey = profileActionHash && isDriver ? `credential:${bytesToHex(profileActionHash)}` : null;
  const { data: credential, mutate: setCredential } = useResource<ProviderCredential | null>(credentialKey, () =>
    getProviderCredentialForProfile(profileActionHash!).then((record) => (record ? decodeEntry<ProviderCredential>(record) : null)),
  );
  const [editing, setEditing] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState(false);
  const [draft, setDraft] = useState({ name: "", bio: "", phone: "", avatar_data_uri: "" });
  const [vehicleDraft, setVehicleDraft] = useState({ vehicle_description: "", license_plate: "", photo_data_uri: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function openStore(hex: string) {
    setActiveStore(hex);
    setMode("merchant");
    navigate("/merchant/catalog");
  }

  // Drafts are filled from the saved values at the moment editing starts
  // -- not kept in sync by an effect, which would let a background profile
  // refresh overwrite whatever's mid-edit.
  function toggleEditing() {
    if (!editing && profile) setDraft({ name: myName ?? profile.display_name, bio: profile.bio, phone: phone ?? "", avatar_data_uri: profile.avatar_data_uri });
    setEditing((v) => !v);
  }

  function toggleEditingVehicle() {
    if (!editingVehicle) {
      setVehicleDraft({
        vehicle_description: credential?.vehicle_description ?? "",
        license_plate: credential?.license_plate ?? "",
        photo_data_uri: credential?.photo_data_uri ?? "",
      });
    }
    setEditingVehicle((v) => !v);
  }

  async function saveProfile() {
    if (!profile || !profileActionHash) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { roles, created_at } = profile;
      const { name, ...rest } = draft;
      await updateProfile(profileActionHash, { display_name: name.trim(), roles, created_at, ...rest });
      await Promise.all([refreshProfile(), reloadPhone(), reloadName()]);
      setEditing(false);
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveVehicle() {
    if (!profileActionHash) return;
    setSaving(true);
    setSaveError(null);
    try {
      await registerProviderCredential({
        profile_action: profileActionHash,
        vehicle_description: vehicleDraft.vehicle_description,
        capabilities: ["Food"],
        verified: false,
        license_plate: vehicleDraft.license_plate,
        photo_data_uri: vehicleDraft.photo_data_uri,
      });
      setCredential(() => ({ ...vehicleDraft, profile_action: profileActionHash, capabilities: ["Food"], verified: false }));
      setEditingVehicle(false);
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  const avgDriverRating = driverRating ? averageRating(driverRating) : null;

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pt-6 pb-8">
      <motion.div variants={fadeSlideUp} className="mb-6 flex flex-col items-center gap-3">
        <motion.div initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
          {editing ? (
            <PhotoInput value={draft.avatar_data_uri} onChange={(v) => setDraft((d) => ({ ...d, avatar_data_uri: v }))} shape="circle" />
          ) : profile?.avatar_data_uri ? (
            <img src={profile.avatar_data_uri} alt="" className="h-20 w-20 rounded-3xl object-cover shadow-xl" />
          ) : (
            <div className="grid h-20 w-20 place-items-center rounded-3xl bg-ink-900 dark:bg-white text-relay-400 dark:text-relay-600 shadow-xl">
              <Radio size={28} />
            </div>
          )}
        </motion.div>
        <h1 className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">{myName ?? profile?.display_name}</h1>
        {isDriver && avgDriverRating !== null && driverRating && (
          <div className="flex items-center gap-1.5 text-xs text-ink-400">
            <Truck size={12} /> <StarRating value={avgDriverRating} count={driverRating.count} />
          </div>
        )}
        <div className="flex gap-1.5">
          {profile?.roles.map((r) => (
            <span key={r} className="rounded-full bg-ink-100 dark:bg-ink-800 px-2.5 py-1 text-xs font-semibold text-ink-500 dark:text-ink-300">
              {t(`role.${r}`)}
            </span>
          ))}
        </div>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
      <Card className="mb-4 p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-400">{t("profile.about")}</p>
          <button onClick={toggleEditing} className="text-ink-400 hover:text-relay-600">
            <Pencil size={14} />
          </button>
        </div>
        <AnimatePresence mode="wait" initial={false}>
        {editing ? (
          <motion.div key="edit" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="flex flex-col gap-2">
            <Input maxLength={MAX_LABEL_CHARS} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder={t("onboarding.name")} aria-label={t("onboarding.name")} />
            <p className="-mt-1 text-[11px] text-ink-400">
              {publicFacing ? t("onboarding.namePublic") : t("onboarding.namePrivate")}
            </p>
            <Textarea maxLength={MAX_NOTE_CHARS} value={draft.bio} onChange={(e) => setDraft((d) => ({ ...d, bio: e.target.value }))} rows={2} placeholder={t("profile.bio")} />
            <Input maxLength={MAX_PHONE_CHARS} value={draft.phone} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} placeholder={t("profile.phone")} type="tel" />
            {saveError && <p className="rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{saveError}</p>}
            <Button loading={saving} onClick={saveProfile} className="py-2 text-xs">
              {t("common.save")}
            </Button>
          </motion.div>
        ) : (
          <motion.div key="view" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <p className="text-sm text-ink-600 dark:text-ink-300">{profile?.bio || t("profile.noBio")}</p>
            {phone && <p className="mt-1 text-xs text-ink-400">{phone}</p>}
          </motion.div>
        )}
        </AnimatePresence>
      </Card>
      </motion.div>

      {profile?.roles.includes("Provider") && (
        <motion.div variants={fadeSlideUp}>
        <Card className="mb-4 p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
              <Truck size={13} /> {t("profile.vehicle")}
            </p>
            <button onClick={toggleEditingVehicle} className="text-ink-400 hover:text-relay-600">
              <Pencil size={14} />
            </button>
          </div>
          <AnimatePresence mode="wait" initial={false}>
          {editingVehicle ? (
            <motion.div key="edit" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="flex flex-col gap-2">
              <PhotoInput value={vehicleDraft.photo_data_uri} onChange={(v) => setVehicleDraft((d) => ({ ...d, photo_data_uri: v }))} shape="banner" />
              <Input
                maxLength={MAX_VEHICLE_CHARS}
                value={vehicleDraft.vehicle_description}
                onChange={(e) => setVehicleDraft((d) => ({ ...d, vehicle_description: e.target.value }))}
                placeholder={t("onboarding.makeModelPlaceholder")}
              />
              <Input
                maxLength={MAX_LICENSE_PLATE_CHARS}
                value={vehicleDraft.license_plate}
                onChange={(e) => setVehicleDraft((d) => ({ ...d, license_plate: e.target.value }))}
                placeholder={t("profile.plate")}
                className="font-mono"
              />
              {saveError && <p className="rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">{saveError}</p>}
              <Button loading={saving} onClick={saveVehicle} className="py-2 text-xs">
                {t("common.save")}
              </Button>
            </motion.div>
          ) : credential ? (
            <motion.div key="view" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3">
              {credential.photo_data_uri && <img src={credential.photo_data_uri} alt="" className="h-12 w-16 rounded-lg object-cover" />}
              <div>
                <p className="text-sm font-semibold text-ink-900 dark:text-ink-50">{credential.vehicle_description}</p>
                {credential.license_plate && <p className="font-mono text-xs text-ink-400">{credential.license_plate}</p>}
              </div>
            </motion.div>
          ) : (
            <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm text-ink-400">{t("profile.noVehicle")}</motion.p>
          )}
          </AnimatePresence>
        </Card>
        </motion.div>
      )}

      <motion.div variants={fadeSlideUp}>
      <LanguagePicker />
      <NotificationSettings runsStore={!!profile?.roles.includes("Merchant")} />
      <Card className="mb-4 p-4">
        <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-400">{t("profile.identity")}</p>
        <p className="break-all font-mono text-xs text-ink-500">{agentPubKey ? encodeHashToBase64(agentPubKey) : "–"}</p>
        <p className="mt-2 text-xs text-ink-400">
          {t("profile.identityDetail")}
        </p>
        {/* In the app, the identity is the app's own; these are the dev host's. */}
        {HOST === "dev" && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-400">
            <Fingerprint size={13} className={hasDeviceLock ? "text-presence-600" : "text-ink-300"} />
            {hasDeviceLock
              ? "Device lock enabled: reconnecting on this device requires your passkey (Face ID, Touch ID, or Windows Hello)."
              : "Device lock not set up. This device has no passkey gate, so reconnecting here doesn't ask for one."}
          </p>
        )}
      </Card>
      </motion.div>

      <motion.div variants={fadeSlideUp} whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}>
        <Link to="/account" className="mb-4 flex items-center gap-3 rounded-2xl border border-ink-100 bg-white p-4 shadow-[var(--shadow-card)] dark:border-ink-800 dark:bg-ink-900">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300">
            <KeyRound size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{t("profile.account")}</p>
            <p className="text-xs text-ink-400">{t("profile.accountDetail")}</p>
          </div>
          <ChevronRight size={18} className="shrink-0 text-ink-300" />
        </Link>
      </motion.div>

      <motion.div variants={fadeSlideUp} className="mb-4 grid grid-cols-2 gap-3">
        <Link to="/wallet" className="block rounded-2xl border border-ink-100 bg-white p-4 shadow-[var(--shadow-card)] transition hover:-translate-y-0.5 dark:border-ink-800 dark:bg-ink-900">
          <p className="flex items-center justify-between text-xs text-ink-400">
            {t("wallet.title")} <ChevronRight size={14} className="text-ink-300" />
          </p>
          {balance === undefined ? <Skeleton className="h-6 w-16 mt-1" /> : <StatNumber className="text-lg">{formatCents(balance)}</StatNumber>}
        </Link>
        {isDriver && (
          <Card className="p-4">
            <p className="text-xs text-ink-400">{t("profile.deliveries")}</p>
            {rep === undefined ? <Skeleton className="h-6 w-10 mt-1" /> : <StatNumber tone="success" className="text-lg">{rep.completed_count}</StatNumber>}
          </Card>
        )}
      </motion.div>

      {isMerchant && stores && stores.length > 0 && (
        <motion.div variants={fadeSlideUp}>
        <Card className="mb-4 p-4">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-ink-400">
            <Store size={13} /> {t("profile.stores", { count: stores.length })}
          </p>
          <div className="flex flex-col divide-y divide-ink-100 dark:divide-ink-800">
            {stores.map((store) => {
              const summary = storeRatings[store.hex];
              const avg = summary ? averageRating(summary) : null;
              return (
                <button key={store.hex} onClick={() => openStore(store.hex)} className="flex items-center gap-3 py-2.5 text-left">
                  <span className={store.catalog.is_open ? "h-2 w-2 shrink-0 rounded-full bg-presence-500" : "h-2 w-2 shrink-0 rounded-full bg-ink-300 dark:bg-ink-600"} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{store.catalog.business_name}</p>
                    {avg !== null && summary ? <StarRating value={avg} count={summary.count} size={11} /> : <p className="text-xs text-ink-400">{t("profile.noRatings")}</p>}
                  </div>
                  <ChevronRight size={16} className="shrink-0 text-ink-300" />
                </button>
              );
            })}
          </div>
        </Card>
        </motion.div>
      )}

      <motion.div variants={fadeSlideUp} whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}>
      <Link to="/transparency" className="mb-4 flex items-center gap-3 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4 shadow-[var(--shadow-card)]">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-relay-500 to-presence-500 text-white">
          <ShieldCheck size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{t("profile.transparency")}</p>
          <p className="text-xs text-ink-400">{t("profile.transparencyDetail")}</p>
        </div>
        <ChevronRight size={18} className="shrink-0 text-ink-300" />
      </Link>
      </motion.div>

      {reviews.length > 0 && (
        <motion.div variants={fadeSlideUp}>
        <Card className="mb-4 p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">{t("profile.driverReviews")}</p>
          <div className="flex flex-col gap-3">
            {reviews.map((r, i) => (
              <div key={i} className="border-b border-ink-100 dark:border-ink-800 pb-2 last:border-0 last:pb-0">
                <StarRating value={r.rating} size={12} />
                {r.comment && <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{r.comment}</p>}
              </div>
            ))}
          </div>
        </Card>
        </motion.div>
      )}

      <motion.div variants={fadeSlideUp} className="mb-4 mt-2 text-center">
        <Link to="/policies" className="text-xs text-ink-400 underline-offset-4 hover:text-ink-600 hover:underline dark:hover:text-ink-200">
          {t("profile.policies")}
        </Link>
      </motion.div>

      {HOST === "dev" && (
        <motion.div variants={fadeSlideUp}>
          {/* Dev only: anyone on the dev node can be anyone on it, by design
              -- it's how one person tests every side of an order. */}
          <DevIdentityPicker
            adminUrl={DEV_ADMIN_URL}
            disabled={false}
            label="Switch to another identity on this node (dev)"
            onPick={async (installedAppId, key) => {
              await adoptIdentity(DEV_ADMIN_URL, installedAppId, key);
              navigate("/");
            }}
          />
          <Button variant="ghost" className="mt-3 w-full" onClick={signOut}>
            <LogOut size={16} /> Disconnect this identity
          </Button>
        </motion.div>
      )}
    </motion.div>
  );
}
