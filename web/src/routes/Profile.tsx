import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Fingerprint, LogOut, Pencil, Radio, ShieldCheck, Truck } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { encodeHashToBase64 } from "@holochain/client";
import { useSession } from "../store/session";
import { getBalance } from "../holochain/zomes/ledger";
import { getReputationSummary } from "../holochain/zomes/reputation";
import { getReviewsFor } from "../holochain/zomes/reputation";
import { updateProfile, getProviderCredentialForProfile, registerProviderCredential } from "../holochain/zomes/profiles";
import { decodeEntry } from "../holochain/decode";
import { Button, Card, Skeleton, StatNumber } from "../components/ui";
import { PhotoInput } from "../components/PhotoInput";
import { StarRating } from "../components/StarRating";
import { formatCents } from "../lib/format";
import { fadeSlideUp, staggerContainer } from "../lib/motion";
import type { ProviderCredential, ReputationSummary, Review } from "../holochain/types";

export function ProfilePage() {
  const { profile, profileActionHash, agentPubKey, hasDeviceLock, signOut, refreshProfile } = useSession();
  const [balance, setBalance] = useState<number | null>(null);
  const [rep, setRep] = useState<ReputationSummary | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [credential, setCredential] = useState<ProviderCredential | null>(null);
  const [editing, setEditing] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState(false);
  const [draft, setDraft] = useState({ bio: "", phone: "", avatar_data_uri: "" });
  const [vehicleDraft, setVehicleDraft] = useState({ vehicle_description: "", license_plate: "", photo_data_uri: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!agentPubKey) return;
    getBalance(agentPubKey).then(setBalance);
    getReputationSummary(agentPubKey).then(setRep);
    getReviewsFor(agentPubKey).then((records) => setReviews(records.map((r) => decodeEntry<Review>(r))));
  }, [agentPubKey]);

  useEffect(() => {
    if (profile) setDraft({ bio: profile.bio, phone: profile.phone, avatar_data_uri: profile.avatar_data_uri });
  }, [profile]);

  useEffect(() => {
    if (!profileActionHash || !profile?.roles.includes("Provider")) return;
    getProviderCredentialForProfile(profileActionHash).then((record) => {
      if (record) {
        const decoded = decodeEntry<ProviderCredential>(record);
        setCredential(decoded);
        setVehicleDraft({ vehicle_description: decoded.vehicle_description, license_plate: decoded.license_plate, photo_data_uri: decoded.photo_data_uri });
      }
    });
  }, [profileActionHash, profile]);

  async function saveProfile() {
    if (!profile || !profileActionHash) return;
    setSaving(true);
    try {
      await updateProfile(profileActionHash, { ...profile, ...draft });
      await refreshProfile();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function saveVehicle() {
    if (!profileActionHash) return;
    setSaving(true);
    try {
      await registerProviderCredential({
        profile_action: profileActionHash,
        vehicle_description: vehicleDraft.vehicle_description,
        capabilities: ["Food"],
        verified: false,
        license_plate: vehicleDraft.license_plate,
        photo_data_uri: vehicleDraft.photo_data_uri,
      });
      setCredential({ ...vehicleDraft, profile_action: profileActionHash, capabilities: ["Food"], verified: false });
      setEditingVehicle(false);
    } finally {
      setSaving(false);
    }
  }

  const avgRating = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;

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
        <h1 className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">{profile?.display_name}</h1>
        {reviews.length > 0 && <StarRating value={avgRating} count={reviews.length} />}
        <div className="flex gap-1.5">
          {profile?.roles.map((r) => (
            <span key={r} className="rounded-full bg-ink-100 dark:bg-ink-800 px-2.5 py-1 text-xs font-semibold text-ink-500 dark:text-ink-300">
              {r}
            </span>
          ))}
        </div>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
      <Card className="mb-4 p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-400">About</p>
          <button onClick={() => setEditing((v) => !v)} className="text-ink-400 hover:text-relay-600">
            <Pencil size={14} />
          </button>
        </div>
        <AnimatePresence mode="wait" initial={false}>
        {editing ? (
          <motion.div key="edit" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="flex flex-col gap-2">
            <textarea
              value={draft.bio}
              onChange={(e) => setDraft((d) => ({ ...d, bio: e.target.value }))}
              rows={2}
              placeholder="Bio"
              className="resize-none rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
            />
            <input
              value={draft.phone}
              onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
              placeholder="Phone"
              className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
            />
            <Button loading={saving} onClick={saveProfile} className="py-2 text-xs">
              Save
            </Button>
          </motion.div>
        ) : (
          <motion.div key="view" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <p className="text-sm text-ink-600 dark:text-ink-300">{profile?.bio || "No bio yet."}</p>
            {profile?.phone && <p className="mt-1 text-xs text-ink-400">{profile.phone}</p>}
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
              <Truck size={13} /> Vehicle
            </p>
            <button onClick={() => setEditingVehicle((v) => !v)} className="text-ink-400 hover:text-relay-600">
              <Pencil size={14} />
            </button>
          </div>
          <AnimatePresence mode="wait" initial={false}>
          {editingVehicle ? (
            <motion.div key="edit" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="flex flex-col gap-2">
              <PhotoInput value={vehicleDraft.photo_data_uri} onChange={(v) => setVehicleDraft((d) => ({ ...d, photo_data_uri: v }))} shape="banner" />
              <input
                value={vehicleDraft.vehicle_description}
                onChange={(e) => setVehicleDraft((d) => ({ ...d, vehicle_description: e.target.value }))}
                placeholder="e.g. Blue Honda Civic"
                className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-relay-400"
              />
              <input
                value={vehicleDraft.license_plate}
                onChange={(e) => setVehicleDraft((d) => ({ ...d, license_plate: e.target.value }))}
                placeholder="License plate"
                className="rounded-lg border border-ink-200 dark:border-ink-700 bg-transparent px-3 py-2 text-sm font-mono outline-none focus:border-relay-400"
              />
              <Button loading={saving} onClick={saveVehicle} className="py-2 text-xs">
                Save
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
            <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm text-ink-400">No vehicle info yet -- tap the pencil to add it.</motion.p>
          )}
          </AnimatePresence>
        </Card>
        </motion.div>
      )}

      <motion.div variants={fadeSlideUp}>
      <Card className="mb-4 p-4">
        <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-400">Agent identity</p>
        <p className="break-all font-mono text-xs text-ink-500">{agentPubKey ? encodeHashToBase64(agentPubKey) : "—"}</p>
        <p className="mt-2 text-xs text-ink-400">
          This is your actual cryptographic identity on the DHT — there's no separate account behind it, and nobody but you holds the private key.
        </p>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-400">
          <Fingerprint size={13} className={hasDeviceLock ? "text-presence-600" : "text-ink-300"} />
          {hasDeviceLock
            ? "Device lock enabled — reconnecting on this device requires your passkey (Face ID / Touch ID / Windows Hello)."
            : "Device lock not set up — this device has no passkey gate, so reconnecting here doesn't ask for one."}
        </p>
      </Card>
      </motion.div>

      <motion.div variants={fadeSlideUp} className="mb-4 grid grid-cols-2 gap-3">
        <Card className="p-4">
          <p className="text-xs text-ink-400">Balance</p>
          {balance === null ? <Skeleton className="h-6 w-16 mt-1" /> : <StatNumber className="text-lg">{formatCents(balance)}</StatNumber>}
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-400">Completed</p>
          {rep === null ? <Skeleton className="h-6 w-10 mt-1" /> : <StatNumber tone="success" className="text-lg">{rep.completed_count}</StatNumber>}
        </Card>
      </motion.div>

      <motion.div variants={fadeSlideUp} whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}>
      <Link to="/transparency" className="mb-4 flex items-center gap-3 rounded-2xl border border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-900 p-4 shadow-[var(--shadow-card)]">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-relay-500 to-presence-500 text-white">
          <ShieldCheck size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink-900 dark:text-ink-50">No-skim transparency</p>
          <p className="text-xs text-ink-400">See every cent, verified from your own ledger -- $0 platform fee, always.</p>
        </div>
        <ChevronRight size={18} className="shrink-0 text-ink-300" />
      </Link>
      </motion.div>

      {reviews.length > 0 && (
        <motion.div variants={fadeSlideUp}>
        <Card className="mb-4 p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">Reviews</p>
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

      <motion.div variants={fadeSlideUp}>
        <Button variant="ghost" className="w-full" onClick={signOut}>
          <LogOut size={16} /> Disconnect this identity
        </Button>
      </motion.div>
    </motion.div>
  );
}
