import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Cake, Clock, Crown, Flame, Gift, Hourglass, Palette, Plus, Sparkles, Trash2, Users } from "lucide-react";
import clsx from "clsx";
import { programOf, programStats, saveProgram } from "../../holochain/zomes/rewards";
import { getCatalog } from "../../holochain/zomes/catalog";
import { decodeEntry, hexToBytes, bytesToHex } from "../../holochain/decode";
import { useMerchantStores, useMyStores } from "../../store/merchantStores";
import { useResource } from "../../lib/hooks/useResource";
import { fetchMenu, type ItemRow } from "../../lib/menu/menu";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { fromMinorUnits, toMinorUnits, currencySymbol } from "../../lib/ui/format";
import { ACCENT_NAMES, ACCENTS, describeHappyHour, starterProgram } from "../../lib/rewards/rewards";
import { describeError } from "../../lib/ui/errors";
import { RewardsCard } from "../../components/rewards/RewardsCard";
import { HowYouEarn, RewardRail, RewardTile } from "../../components/rewards/RewardPieces";
import { StoreSwitcher } from "../../components/StoreSwitcher";
import { Button, Card, Field, Input, Select, Skeleton, Switch } from "../../components/ui";
import { MAX_HAPPY_HOURS, MAX_ITEM_BONUSES, MAX_REWARDS, MAX_TIERS, type MerchantCatalog, type PromoReward, type Reward, type RewardsProgram } from "../../holochain/types";
import { useT } from "../../i18n";

type Translate = ReturnType<typeof useT>;

/// What's wrong with a draft, in words -- the network's limits
/// (`RewardsProgram::problem`), told before saving.
function draftProblem(p: RewardsProgram, t: Translate): string | null {
  if (!p.name.trim() || !p.points_name.trim()) return t("rewardsAdmin.problem.names");
  if (p.earn.points_per_dollar < 1 || p.earn.points_per_dollar > 100) return t("rewardsAdmin.problem.rate");
  for (const [i, tier] of p.tiers.entries()) {
    if (!tier.name.trim()) return t("rewardsAdmin.problem.tierName");
    if (tier.threshold <= (i === 0 ? 0 : p.tiers[i - 1].threshold)) return t("rewardsAdmin.problem.tierOrder");
    if (tier.percent < (i === 0 ? 100 : p.tiers[i - 1].percent)) return t("rewardsAdmin.problem.tierRate");
  }
  for (const reward of p.rewards) {
    if (!reward.name.trim()) return t("rewardsAdmin.problem.rewardName");
    if (reward.cost < 1) return t("rewardsAdmin.problem.rewardCost");
    if (reward.min_tier > p.tiers.length) return t("rewardsAdmin.problem.rewardTier");
  }
  for (const hour of p.earn.happy_hours) {
    if (hour.days === 0 || hour.start_minute >= hour.end_minute) return t("rewardsAdmin.problem.hours");
  }
  const dearest = Math.max(1, ...p.rewards.map((r) => r.cost));
  if (p.max_balance !== null && p.max_balance < dearest) return t("rewardsAdmin.problem.cap");
  if (p.expiry_days !== null && (p.expiry_days < 30 || p.expiry_days > 1095)) return t("rewardsAdmin.problem.expiry");
  return null;
}

/// The Rewards tab: the selected store's program, built with its card
/// drawn live above.
export function MerchantRewards() {
  const stores = useMyStores();
  const activeHex = useMerchantStores((s) => s.activeHex);
  if (stores === null || !activeHex) {
    return (
      <div className="px-4 pt-4">
        <Skeleton className="h-52 w-full rounded-[28px]" />
      </div>
    );
  }
  return <ProgramBuilder key={activeHex} storeHex={activeHex} />;
}

async function fetchBuilder(catalogRef: Uint8Array) {
  const [view, menu, record] = await Promise.all([programOf(catalogRef), fetchMenu(catalogRef), getCatalog(catalogRef)]);
  return { view, menu, store: decodeEntry<MerchantCatalog>(record) };
}

function ProgramBuilder({ storeHex }: { storeHex: string }) {
  const t = useT();
  const catalogRef = useMemo(() => hexToBytes(storeHex), [storeHex]);
  const { data, reload } = useResource(`rewards-admin:${storeHex}`, () => fetchBuilder(catalogRef));
  const { data: stats } = useResource(`rewards-stats:${storeHex}`, () => programStats(catalogRef));
  // The program as edited -- `null` until changed, the saved one till then.
  const [edited, setDraft] = useState<RewardsProgram | null>(null);
  const [previewPoints, setPreviewPoints] = useState(240);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = edited ?? (data ? (data.view?.program ?? starterProgram(catalogRef, data.store.business_name)) : null);

  if (!data || !draft) {
    return (
      <div className="px-4 pt-4">
        <StoreSwitcher />
        <Skeleton className="mt-4 h-52 w-full rounded-[28px]" />
        <Skeleton className="mt-4 h-40 w-full" />
      </div>
    );
  }
  const { menu, store } = data;
  const update = (change: (p: RewardsProgram) => RewardsProgram) => {
    setSaved(false);
    setDraft(change(structuredClone(draft)));
  };
  const problem = draftProblem(draft, t);
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.view?.program ?? null);
  const previewTier = draft.tiers.filter((tier) => previewPoints >= tier.threshold).length;

  async function save() {
    if (!draft || problem) return;
    setSaving(true);
    setError(null);
    try {
      await saveProgram(draft);
      await reload();
      setSaved(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-40 pt-4">
      <StoreSwitcher />
      <motion.div variants={fadeSlideUp} className="mb-4 mt-3 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-ink-900 dark:text-ink-50">{t("rewardsAdmin.title")}</h1>
          <p className="text-sm text-ink-500">{data.view ? t("rewardsAdmin.subtitleLive") : t("rewardsAdmin.subtitleNew")}</p>
        </div>
        {data.view && <Switch checked={draft.active} onChange={(active) => update((p) => ({ ...p, active }))} label={t("rewardsAdmin.running")} />}
      </motion.div>

      {/* The card as members will see it, live. */}
      <motion.div variants={fadeSlideUp} className="sticky top-2 z-20">
        <RewardsCard program={draft} storeName={store.business_name} balance={previewPoints} tier={previewTier} />
      </motion.div>
      <motion.div variants={fadeSlideUp} className="mt-3 flex items-center gap-3 px-1">
        <span className="shrink-0 text-xs font-semibold text-ink-400">{t("rewardsAdmin.previewAt")}</span>
        <input type="range" min={0} max={Math.max(1000, ...draft.rewards.map((r) => r.cost), ...draft.tiers.map((x) => x.threshold))} value={previewPoints} onChange={(e) => setPreviewPoints(Number(e.target.value))} className="flex-1 accent-handshake-500" aria-label={t("rewardsAdmin.previewAt")} />
      </motion.div>

      {stats && data.view && (
        <motion.div variants={fadeSlideUp} className="mt-5 grid grid-cols-2 gap-3">
          <Stat icon={Users} label={t("rewardsAdmin.stats.members")} value={stats.members} sub={t("rewardsAdmin.stats.active", { count: stats.active_members })} />
          <Stat icon={Sparkles} label={t("rewardsAdmin.stats.earned")} value={stats.points_earned} sub={draft.points_name} />
          <Stat icon={Gift} label={t("rewardsAdmin.stats.redeemed")} value={stats.redemptions} sub={t("rewardsAdmin.stats.rewards")} />
          <Stat icon={Crown} label={t("rewardsAdmin.stats.tiers")} value={draft.tiers.length} sub={t("rewardsAdmin.stats.levels")} />
        </motion.div>
      )}

      <Section icon={Palette} title={t("rewardsAdmin.brand")}>
        <div className="grid gap-3">
          <Field label={t("rewardsAdmin.name")}>
            <Input maxLength={40} value={draft.name} onChange={(e) => update((p) => ({ ...p, name: e.target.value }))} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("rewardsAdmin.pointsName")}>
              <Input maxLength={20} value={draft.points_name} onChange={(e) => update((p) => ({ ...p, points_name: e.target.value }))} placeholder="points" />
            </Field>
            <Field label={t("rewardsAdmin.timeZone")}>
              <Input value={draft.time_zone} onChange={(e) => update((p) => ({ ...p, time_zone: e.target.value }))} />
            </Field>
          </div>
          <Field label={t("rewardsAdmin.tagline")}>
            <Input maxLength={120} value={draft.tagline} onChange={(e) => update((p) => ({ ...p, tagline: e.target.value }))} placeholder={t("rewardsAdmin.taglineHint")} />
          </Field>
          <div>
            <p className="mb-2 text-xs font-semibold text-ink-500">{t("rewardsAdmin.colour")}</p>
            <div className="flex gap-2.5">
              {ACCENT_NAMES.map((accent) => (
                <motion.button
                  key={accent}
                  type="button"
                  whileTap={{ scale: 0.9 }}
                  aria-label={accent}
                  onClick={() => update((p) => ({ ...p, accent }))}
                  className={clsx("h-10 w-10 rounded-full ring-offset-2 transition dark:ring-offset-ink-900", draft.accent === accent ? "ring-2 ring-ink-900 dark:ring-white" : "")}
                  style={{ backgroundImage: `linear-gradient(135deg, ${ACCENTS[accent].from}, ${ACCENTS[accent].to})` }}
                />
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section icon={Sparkles} title={t("rewardsAdmin.earning")}>
        <div className="grid gap-4">
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-xs font-semibold text-ink-500">{t("rewardsAdmin.rate")}</span>
              <span className="text-lg font-black tabular-nums text-ink-900 dark:text-ink-50">
                {draft.earn.points_per_dollar} <span className="text-xs font-semibold text-ink-400">{t("rewardsAdmin.perDollar", { name: draft.points_name })}</span>
              </span>
            </div>
            <input type="range" min={1} max={100} value={draft.earn.points_per_dollar} onChange={(e) => update((p) => ({ ...p, earn: { ...p.earn, points_per_dollar: Number(e.target.value) } }))} className="w-full accent-handshake-500" aria-label={t("rewardsAdmin.rate")} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("rewardsAdmin.welcome")}>
              <Input type="number" min={0} max={100000} value={draft.earn.welcome_bonus} onChange={(e) => update((p) => ({ ...p, earn: { ...p.earn, welcome_bonus: clamp(e.target.value, 0, 100000) } }))} suffix="pts" />
            </Field>
            <Field label={t("rewardsAdmin.minOrder")}>
              <Input type="number" min={0} step="0.01" value={fromMinorUnits(draft.earn.min_order_cents)} onChange={(e) => update((p) => ({ ...p, earn: { ...p.earn, min_order_cents: toMinorUnits(Math.max(0, Number(e.target.value) || 0)) } }))} prefix={currencySymbol()} />
            </Field>
          </div>
          <OptionalNumber label={t("rewardsAdmin.capPerOrder")} hint={t("rewardsAdmin.capPerOrderHint")} value={draft.earn.max_per_order} fallback={500} max={1_000_000} onChange={(max_per_order) => update((p) => ({ ...p, earn: { ...p.earn, max_per_order } }))} />
        </div>
      </Section>

      <Section icon={Flame} title={t("rewardsAdmin.boosts")} hint={t("rewardsAdmin.boostsHint")}>
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">{t("rewardsAdmin.itemBoosts")}</p>
        <div className="flex flex-col gap-2">
          {draft.earn.item_bonuses.map((bonus, i) => (
            <Row key={i} onRemove={() => update((p) => ({ ...p, earn: { ...p.earn, item_bonuses: p.earn.item_bonuses.filter((_, j) => j !== i) } }))}>
              <ItemSelect menu={menu} value={bonus.item_ref} onChange={(item_ref) => update((p) => withBonus(p, i, { ...p.earn.item_bonuses[i], item_ref }))} />
              <MultiplierSelect options={[150, 200, 300, 500, 1000]} value={bonus.percent} onChange={(percent) => update((p) => withBonus(p, i, { ...p.earn.item_bonuses[i], percent }))} />
            </Row>
          ))}
        </div>
        {draft.earn.item_bonuses.length < MAX_ITEM_BONUSES && menu.length > 0 && (
          <AddButton onClick={() => update((p) => ({ ...p, earn: { ...p.earn, item_bonuses: [...p.earn.item_bonuses, { item_ref: unusedItem(menu, p.earn.item_bonuses.map((b) => b.item_ref)), percent: 200 }] } }))}>{t("rewardsAdmin.addItemBoost")}</AddButton>
        )}

        <p className="mb-2 mt-5 text-xs font-bold uppercase tracking-wide text-ink-400">{t("rewardsAdmin.happyHours")}</p>
        <div className="flex flex-col gap-3">
          {draft.earn.happy_hours.map((hour, i) => (
            <div key={i} className="rounded-2xl bg-ink-50 p-3 dark:bg-ink-800/60">
              <div className="mb-2 flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-600 dark:text-ink-300">
                  <Clock size={13} /> {describeHappyHour(hour.days, hour.start_minute, hour.end_minute, t)}
                </p>
                <button type="button" aria-label={t("common.remove")} onClick={() => update((p) => ({ ...p, earn: { ...p.earn, happy_hours: p.earn.happy_hours.filter((_, j) => j !== i) } }))} className="text-ink-400 hover:text-red-500">
                  <Trash2 size={15} />
                </button>
              </div>
              <DayPicker days={hour.days} onChange={(days) => update((p) => withHour(p, i, { ...p.earn.happy_hours[i], days }))} />
              <div className="mt-2 grid grid-cols-3 gap-2">
                <Input type="time" value={clock(hour.start_minute)} onChange={(e) => update((p) => withHour(p, i, { ...p.earn.happy_hours[i], start_minute: minutes(e.target.value) }))} aria-label={t("rewardsAdmin.starts")} />
                <Input type="time" value={clock(hour.end_minute)} onChange={(e) => update((p) => withHour(p, i, { ...p.earn.happy_hours[i], end_minute: minutes(e.target.value) || 1440 }))} aria-label={t("rewardsAdmin.ends")} />
                <MultiplierSelect options={[150, 200, 300, 500]} value={hour.percent} onChange={(percent) => update((p) => withHour(p, i, { ...p.earn.happy_hours[i], percent }))} />
              </div>
            </div>
          ))}
        </div>
        {draft.earn.happy_hours.length < MAX_HAPPY_HOURS && (
          <AddButton onClick={() => update((p) => ({ ...p, earn: { ...p.earn, happy_hours: [...p.earn.happy_hours, { days: 0b0011111, start_minute: 14 * 60, end_minute: 16 * 60, percent: 200 }] } }))}>{t("rewardsAdmin.addHappyHour")}</AddButton>
        )}
      </Section>

      <Section icon={Gift} title={t("rewardsAdmin.rewards")} hint={t("rewardsAdmin.rewardsHint")}>
        {draft.rewards.length > 0 && (
          <div className="mb-4">
            <RewardRail>
              {[...draft.rewards]
                .sort((a, b) => a.cost - b.cost)
                .map((reward) => (
                  <RewardTile key={reward.id} program={draft} reward={reward} balance={previewPoints} tier={previewTier} menu={menu} />
                ))}
            </RewardRail>
          </div>
        )}
        <div className="flex flex-col gap-3">
          {draft.rewards.map((reward, i) => (
            <RewardEditor key={reward.id} reward={reward} menu={menu} tiers={draft.tiers.map((x) => x.name)} pointsName={draft.points_name} onChange={(next) => update((p) => ({ ...p, rewards: p.rewards.map((r, j) => (j === i ? next : r)) }))} onRemove={() => update((p) => ({ ...p, rewards: p.rewards.filter((_, j) => j !== i) }))} />
          ))}
        </div>
        {draft.rewards.length < MAX_REWARDS && (
          <AddButton
            onClick={() =>
              update((p) => {
                const id = Math.max(0, ...p.rewards.map((r) => r.id)) + 1;
                const benefit: PromoReward = menu[0] ? { FreeItem: { item_ref: menu[0].hash, quantity: 1 } } : { FlatOffSubtotal: 500 };
                return { ...p, rewards: [...p.rewards, { id, name: menu[0] ? t("rewardsAdmin.freeNamed", { item: menu[0].item.name }) : t("rewardsAdmin.dollarsOff"), cost: 100 * id, benefit, min_tier: 0 }] };
              })
            }
          >
            {t("rewardsAdmin.addReward")}
          </AddButton>
        )}
      </Section>

      <Section icon={Crown} title={t("rewardsAdmin.tiers")} hint={t("rewardsAdmin.tiersHint")}>
        <div className="flex flex-col gap-3">
          {draft.tiers.map((tier, i) => (
            <div key={i} className="rounded-2xl bg-ink-50 p-3 dark:bg-ink-800/60">
              <div className="mb-2 flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-full text-white" style={{ backgroundImage: `linear-gradient(135deg, ${ACCENTS[draft.accent].from}, ${ACCENTS[draft.accent].to})` }}>
                  <Crown size={13} />
                </span>
                <Input maxLength={24} value={tier.name} onChange={(e) => update((p) => withTier(p, i, { ...p.tiers[i], name: e.target.value }))} className="flex-1 py-2" aria-label={t("rewardsAdmin.tierName")} />
                <button type="button" aria-label={t("common.remove")} onClick={() => update((p) => ({ ...p, tiers: p.tiers.filter((_, j) => j !== i), rewards: p.rewards.map((r) => ({ ...r, min_tier: Math.min(r.min_tier, p.tiers.length - 1) })) }))} className="text-ink-400 hover:text-red-500">
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t("rewardsAdmin.tierAt")}>
                  <Input type="number" min={1} value={tier.threshold} onChange={(e) => update((p) => withTier(p, i, { ...p.tiers[i], threshold: clamp(e.target.value, 1, 1_000_000_000) }))} suffix="pts" />
                </Field>
                <Field label={t("rewardsAdmin.tierEarns")}>
                  <MultiplierSelect options={[100, 110, 125, 150, 175, 200, 250, 300]} value={tier.percent} onChange={(percent) => update((p) => withTier(p, i, { ...p.tiers[i], percent }))} />
                </Field>
              </div>
              <Input maxLength={120} value={tier.perk} onChange={(e) => update((p) => withTier(p, i, { ...p.tiers[i], perk: e.target.value }))} placeholder={t("rewardsAdmin.perkHint")} className="mt-2" />
            </div>
          ))}
        </div>
        {draft.tiers.length < MAX_TIERS && (
          <AddButton
            onClick={() =>
              update((p) => {
                const last = p.tiers[p.tiers.length - 1];
                const names = ["Silver", "Gold", "Platinum", "Diamond"];
                return { ...p, tiers: [...p.tiers, { name: names[p.tiers.length] ?? "Tier", threshold: (last?.threshold ?? 0) + 1000, percent: Math.min(300, (last?.percent ?? 100) + 25), perk: "" }] };
              })
            }
          >
            {t("rewardsAdmin.addTier")}
          </AddButton>
        )}
      </Section>

      <Section icon={Cake} title={t("rewardsAdmin.extras")}>
        <div className="grid gap-4">
          <Field label={t("rewardsAdmin.birthday")}>
            <Input type="number" min={0} max={100000} value={draft.birthday_points} onChange={(e) => update((p) => ({ ...p, birthday_points: clamp(e.target.value, 0, 100000) }))} suffix="pts" />
          </Field>
          <p className="-mt-2 text-xs text-ink-400">{t("rewardsAdmin.birthdayHint")}</p>
          <OptionalNumber icon={Hourglass} label={t("rewardsAdmin.expiry")} hint={t("rewardsAdmin.expiryHint")} value={draft.expiry_days} fallback={180} min={30} max={1095} suffix={t("rewardsAdmin.days")} onChange={(expiry_days) => update((p) => ({ ...p, expiry_days }))} />
          <OptionalNumber label={t("rewardsAdmin.maxBalance")} hint={t("rewardsAdmin.maxBalanceHint")} value={draft.max_balance} fallback={Math.max(5000, ...draft.rewards.map((r) => r.cost))} max={1_000_000_000} onChange={(max_balance) => update((p) => ({ ...p, max_balance }))} />
        </div>
      </Section>

      <Section icon={Sparkles} title={t("rewardsAdmin.membersSee")}>
        <HowYouEarn program={draft} menu={menu} />
      </Section>

      {/* Saving, kept in reach. */}
      <div className="fixed inset-x-0 bottom-20 z-30 px-4">
        <div className="mx-auto max-w-lg rounded-2xl bg-white/90 p-3 shadow-[var(--shadow-float)] backdrop-blur-md dark:bg-ink-900/90">
          <AnimatePresence>
            {(problem || error) && (
              <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mb-2 text-xs font-semibold text-red-600">
                {problem ?? error}
              </motion.p>
            )}
          </AnimatePresence>
          <Button className="w-full" onClick={save} loading={saving} disabled={!!problem || (!dirty && !!data.view)}>
            {saved && !dirty ? t("rewardsAdmin.saved") : data.view ? t("rewardsAdmin.save") : t("rewardsAdmin.launch")}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

const clamp = (value: string, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(value) || 0)));
const clock = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const minutes = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
const withBonus = (p: RewardsProgram, i: number, bonus: RewardsProgram["earn"]["item_bonuses"][number]) => ({ ...p, earn: { ...p.earn, item_bonuses: p.earn.item_bonuses.map((b, j) => (j === i ? bonus : b)) } });
const withHour = (p: RewardsProgram, i: number, hour: RewardsProgram["earn"]["happy_hours"][number]) => ({ ...p, earn: { ...p.earn, happy_hours: p.earn.happy_hours.map((h, j) => (j === i ? hour : h)) } });
const withTier = (p: RewardsProgram, i: number, tier: RewardsProgram["tiers"][number]) => ({ ...p, tiers: p.tiers.map((x, j) => (j === i ? tier : x)) });
const unusedItem = (menu: ItemRow[], used: Uint8Array[]) => (menu.find((m) => !used.some((u) => bytesToHex(u) === bytesToHex(m.hash))) ?? menu[0]).hash;

function Section({ icon: Icon, title, hint, children }: { icon: typeof Sparkles; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <motion.section variants={fadeSlideUp} className="mt-6">
      <div className="mb-2 flex items-center gap-2 px-1">
        <Icon size={15} className="text-handshake-500" />
        <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-ink-500">{title}</h2>
      </div>
      {hint && <p className="mb-2 px-1 text-xs text-ink-400">{hint}</p>}
      <Card className="p-4">{children}</Card>
    </motion.section>
  );
}

function Stat({ icon: Icon, label, value, sub }: { icon: typeof Sparkles; label: string; value: number; sub: string }) {
  return (
    <Card className="p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-400">
        <Icon size={12} /> {label}
      </p>
      <p className="mt-1 text-2xl font-black tabular-nums text-ink-900 dark:text-ink-50">{value.toLocaleString()}</p>
      <p className="text-xs text-ink-400">{sub}</p>
    </Card>
  );
}

function Row({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <div className="grid flex-1 grid-cols-[1fr_auto] gap-2">{children}</div>
      <button type="button" aria-label={t("common.remove")} onClick={onRemove} className="text-ink-400 hover:text-red-500">
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <motion.button type="button" whileTap={{ scale: 0.97 }} onClick={onClick} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-ink-200 py-3 text-sm font-semibold text-ink-500 hover:border-handshake-300 hover:text-handshake-600 dark:border-ink-700">
      <Plus size={15} /> {children}
    </motion.button>
  );
}

function ItemSelect({ menu, value, onChange }: { menu: ItemRow[]; value: Uint8Array; onChange: (item: Uint8Array) => void }) {
  return (
    <Select value={bytesToHex(value)} onChange={(e) => onChange(hexToBytes(e.target.value))}>
      {menu.map((row) => (
        <option key={bytesToHex(row.hash)} value={bytesToHex(row.hash)}>
          {row.item.name}
        </option>
      ))}
    </Select>
  );
}

function MultiplierSelect({ options, value, onChange }: { options: number[]; value: number; onChange: (percent: number) => void }) {
  const all = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <Select value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {all.map((percent) => (
        <option key={percent} value={percent}>
          {(percent / 100).toString()}×
        </option>
      ))}
    </Select>
  );
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function DayPicker({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  const t = useT();
  return (
    <div className="flex gap-1.5">
      {DAYS.map((day, i) => {
        const on = (days & (1 << i)) !== 0;
        return (
          <button key={day} type="button" onClick={() => onChange(days ^ (1 << i))} className={clsx("h-8 flex-1 rounded-lg text-[11px] font-bold transition", on ? "bg-ink-900 text-white dark:bg-white dark:text-ink-900" : "bg-white text-ink-400 dark:bg-ink-900")}>
            {t(`rewards.day.${day}`)}
          </button>
        );
      })}
    </div>
  );
}

/// A limit that's off until it's switched on.
function OptionalNumber({ icon: Icon, label, hint, value, fallback, min = 1, max, suffix = "pts", onChange }: { icon?: typeof Sparkles; label: string; hint: string; value: number | null; fallback: number; min?: number; max: number; suffix?: string; onChange: (value: number | null) => void }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-ink-900 dark:text-ink-50">
            {Icon && <Icon size={14} className="text-ink-400" />} {label}
          </p>
          <p className="text-xs text-ink-400">{hint}</p>
        </div>
        <Switch checked={value !== null} onChange={(on) => onChange(on ? fallback : null)} label={label} />
      </div>
      {value !== null && <Input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, Math.floor(Number(e.target.value) || min))))} suffix={suffix} className="mt-2" />}
    </div>
  );
}

type BenefitKind = "FreeItem" | "PercentOffItem" | "FlatOffSubtotal" | "PercentOffSubtotal";
const kindOf = (benefit: PromoReward): BenefitKind => Object.keys(benefit)[0] as BenefitKind;

/// One reward, edited.
function RewardEditor({ reward, menu, tiers, pointsName, onChange, onRemove }: { reward: Reward; menu: ItemRow[]; tiers: string[]; pointsName: string; onChange: (reward: Reward) => void; onRemove: () => void }) {
  const t = useT();
  const kind = kindOf(reward.benefit);
  const firstItem = menu[0]?.hash ?? new Uint8Array(39);
  const setKind = (next: BenefitKind) => {
    const item = "FreeItem" in reward.benefit ? reward.benefit.FreeItem.item_ref : "PercentOffItem" in reward.benefit ? reward.benefit.PercentOffItem.item_ref : firstItem;
    const benefit: PromoReward =
      next === "FreeItem" ? { FreeItem: { item_ref: item, quantity: 1 } } : next === "PercentOffItem" ? { PercentOffItem: { item_ref: item, percent: 50, quantity: 1 } } : next === "FlatOffSubtotal" ? { FlatOffSubtotal: 500 } : { PercentOffSubtotal: 10 };
    onChange({ ...reward, benefit });
  };
  return (
    <div className="rounded-2xl bg-ink-50 p-3 dark:bg-ink-800/60">
      <div className="mb-2 flex items-center gap-2">
        <Input maxLength={60} value={reward.name} onChange={(e) => onChange({ ...reward, name: e.target.value })} className="flex-1 py-2 font-semibold" aria-label={t("rewardsAdmin.rewardName")} />
        <button type="button" aria-label={t("common.remove")} onClick={onRemove} className="text-ink-400 hover:text-red-500">
          <Trash2 size={15} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("rewardsAdmin.cost")}>
          <Input type="number" min={1} max={1_000_000} value={reward.cost} onChange={(e) => onChange({ ...reward, cost: clamp(e.target.value, 1, 1_000_000) })} suffix={pointsName.slice(0, 4)} />
        </Field>
        <Field label={t("rewardsAdmin.gives")}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as BenefitKind)}>
            {menu.length > 0 && <option value="FreeItem">{t("rewardsAdmin.kind.free")}</option>}
            {menu.length > 0 && <option value="PercentOffItem">{t("rewardsAdmin.kind.percentItem")}</option>}
            <option value="FlatOffSubtotal">{t("rewardsAdmin.kind.flat")}</option>
            <option value="PercentOffSubtotal">{t("rewardsAdmin.kind.percent")}</option>
          </Select>
        </Field>
        {"FreeItem" in reward.benefit && (
          <div className="col-span-2">
            <ItemSelect menu={menu} value={reward.benefit.FreeItem.item_ref} onChange={(item_ref) => onChange({ ...reward, benefit: { FreeItem: { item_ref, quantity: 1 } } })} />
          </div>
        )}
        {"PercentOffItem" in reward.benefit && (
          <>
            <ItemSelect menu={menu} value={reward.benefit.PercentOffItem.item_ref} onChange={(item_ref) => onChange({ ...reward, benefit: { PercentOffItem: { ...(reward.benefit as { PercentOffItem: { item_ref: Uint8Array; percent: number; quantity: number } }).PercentOffItem, item_ref } } })} />
            <Input type="number" min={1} max={100} value={reward.benefit.PercentOffItem.percent} onChange={(e) => onChange({ ...reward, benefit: { PercentOffItem: { ...(reward.benefit as { PercentOffItem: { item_ref: Uint8Array; percent: number; quantity: number } }).PercentOffItem, percent: clamp(e.target.value, 1, 100) } } })} suffix="%" />
          </>
        )}
        {"FlatOffSubtotal" in reward.benefit && (
          <div className="col-span-2">
            <Input type="number" min={0.01} step="0.01" value={fromMinorUnits(reward.benefit.FlatOffSubtotal)} onChange={(e) => onChange({ ...reward, benefit: { FlatOffSubtotal: Math.max(1, toMinorUnits(Number(e.target.value) || 0)) } })} prefix={currencySymbol()} />
          </div>
        )}
        {"PercentOffSubtotal" in reward.benefit && (
          <div className="col-span-2">
            <Input type="number" min={1} max={100} value={reward.benefit.PercentOffSubtotal} onChange={(e) => onChange({ ...reward, benefit: { PercentOffSubtotal: clamp(e.target.value, 1, 100) } })} suffix="%" />
          </div>
        )}
        {tiers.length > 0 && (
          <div className="col-span-2">
            <Select value={reward.min_tier} onChange={(e) => onChange({ ...reward, min_tier: Number(e.target.value) })}>
              <option value={0}>{t("rewardsAdmin.forEveryone")}</option>
              {tiers.map((name, i) => (
                <option key={i} value={i + 1}>
                  {t("rewardsAdmin.forTierUp", { tier: name })}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
    </div>
  );
}
