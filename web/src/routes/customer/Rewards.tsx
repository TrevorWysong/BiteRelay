import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Cake, ChevronRight, Gift, Minus, Plus, ShoppingBag, Sparkles } from "lucide-react";
import clsx from "clsx";
import { myBirthMonth, myCard, myCards, setBirthMonth } from "../../holochain/zomes/rewards";
import { bytesToHex, hexToBytes } from "../../holochain/decode";
import { useResource } from "../../lib/hooks/useResource";
import { fetchMenu } from "../../lib/menu/menu";
import { fadeSlideUp, staggerContainer } from "../../lib/ui/motion";
import { ACCENTS, expiresAt, tierOf } from "../../lib/rewards/rewards";
import { RewardsCard } from "../../components/rewards/RewardsCard";
import { HowYouEarn, RewardRail, RewardTile, TierLadder } from "../../components/rewards/RewardPieces";
import { Button, Card, Skeleton } from "../../components/ui";
import { describeError } from "../../lib/ui/errors";
import type { CardView, PointsLine } from "../../holochain/types";
import { useT } from "../../i18n";

/// Every rewards card the customer holds, most recently used first, and
/// their birthday month.
export function RewardsPage() {
  const t = useT();
  const navigate = useNavigate();
  const { data: cards } = useResource("rewards:cards", myCards);

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-28 pt-5">
      <motion.div variants={fadeSlideUp} className="mb-5">
        <h1 className="text-2xl font-black tracking-tight text-ink-900 dark:text-ink-50">{t("rewards.title")}</h1>
        <p className="mt-1 text-sm text-ink-500">{t("rewards.subtitle")}</p>
      </motion.div>

      {cards === undefined && (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-44 w-full rounded-[28px]" />
          <Skeleton className="h-44 w-full rounded-[28px]" />
        </div>
      )}
      {cards && cards.length === 0 && (
        <motion.div variants={fadeSlideUp} className="relative overflow-hidden rounded-[28px] bg-ink-900 p-7 text-white">
          <div aria-hidden className="absolute -right-10 -top-16 h-48 w-48 rounded-full bg-handshake-500/40 blur-3xl" />
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white/10">
            <Sparkles size={22} />
          </span>
          <p className="mt-4 text-lg font-black">{t("rewards.emptyTitle")}</p>
          <p className="mt-1 text-sm text-white/70">{t("rewards.emptyBody")}</p>
          <Button className="mt-5" onClick={() => navigate("/customer")}>
            <ShoppingBag size={16} /> {t("rewards.findStores")}
          </Button>
        </motion.div>
      )}
      <div className="flex flex-col gap-4">
        {cards
          ?.filter((card) => card.program)
          .map((card) => (
            <motion.div key={bytesToHex(card.catalog_ref)} variants={fadeSlideUp}>
              <RewardsCard compact program={card.program!.program} storeName={card.store_name} balance={card.balance} tier={card.tier} onClick={() => navigate(`/rewards/${bytesToHex(card.catalog_ref)}`)} />
            </motion.div>
          ))}
      </div>

      <motion.div variants={fadeSlideUp} className="mt-6">
        <BirthdayCard />
      </motion.div>
    </motion.div>
  );
}

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: "long" }));

/// The customer's birth month -- set once, for every store's birthday treat.
function BirthdayCard() {
  const t = useT();
  const { data: month, reload } = useResource("rewards:birth-month", myBirthMonth);
  const [choice, setChoice] = useState(() => new Date().getMonth() + 1);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (month === undefined) return null;
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-pink-400 to-fuchsia-600 text-white">
          <Cake size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{t("rewards.birthdayTitle")}</p>
          <p className="text-xs text-ink-500">{month ? t("rewards.birthdaySet", { month: MONTHS[month - 1] }) : t("rewards.birthdayBody")}</p>
        </div>
      </div>
      {month === null && (
        <div className="mt-4">
          <div className="flex items-center justify-between rounded-2xl bg-ink-50 p-1.5 dark:bg-ink-800">
            <button type="button" aria-label={t("rewards.prevMonth")} onClick={() => setChoice((m) => (m === 1 ? 12 : m - 1))} className="grid h-9 w-9 place-items-center rounded-xl hover:bg-white dark:hover:bg-ink-700">
              <Minus size={16} />
            </button>
            <span className="text-sm font-bold text-ink-900 dark:text-ink-50">{MONTHS[choice - 1]}</span>
            <button type="button" aria-label={t("rewards.nextMonth")} onClick={() => setChoice((m) => (m === 12 ? 1 : m + 1))} className="grid h-9 w-9 place-items-center rounded-xl hover:bg-white dark:hover:bg-ink-700">
              <Plus size={16} />
            </button>
          </div>
          {confirming ? (
            <div className="mt-3">
              <p className="mb-2 text-xs text-ink-500">{t("rewards.birthdayOnce", { month: MONTHS[choice - 1] })}</p>
              <div className="flex gap-2">
                <Button variant="ghost" className="flex-1" onClick={() => setConfirming(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  className="flex-1"
                  loading={saving}
                  onClick={async () => {
                    setSaving(true);
                    setError(null);
                    try {
                      await setBirthMonth(choice);
                      await reload();
                    } catch (err) {
                      setError(describeError(err));
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  {t("rewards.birthdayConfirm")}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" className="mt-3 w-full" onClick={() => setConfirming(true)}>
              {t("rewards.birthdaySave")}
            </Button>
          )}
          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        </div>
      )}
    </Card>
  );
}

/// One store's card, opened: where the customer stands, what their points
/// buy, their status, how they earn and what they've done.
export function RewardsDetail() {
  const t = useT();
  const navigate = useNavigate();
  const { hash } = useParams<{ hash: string }>();
  const catalogRef = hexToBytes(hash ?? "");
  const { data: card } = useResource(hash ? `rewards:card:${hash}` : null, () => myCard(catalogRef));
  const { data: menu = [] } = useResource(hash ? `store-menu-items:${hash}` : null, () => fetchMenu(catalogRef));

  if (!card) {
    return (
      <div className="px-4 pt-5">
        <Skeleton className="h-60 w-full rounded-[28px]" />
        <Skeleton className="mt-4 h-40 w-full" />
      </div>
    );
  }
  if (!card.program) {
    return <div className="px-6 py-20 text-center text-sm text-ink-400">{t("rewards.noProgram")}</div>;
  }
  const program = card.program.program;
  const rewards = [...program.rewards].sort((a, b) => a.cost - b.cost);

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-28 pt-4">
      <motion.button variants={fadeSlideUp} onClick={() => navigate(-1)} className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-500">
        <ArrowLeft size={16} /> {t("common.back")}
      </motion.button>
      <motion.div variants={fadeSlideUp}>
        <RewardsCard program={program} storeName={card.store_name} balance={card.balance} tier={card.tier} expiresAt={card.expires_at ?? expiresAt(program, card.state)} />
      </motion.div>

      <motion.div variants={fadeSlideUp} className="mt-4">
        <Button className="w-full" onClick={() => navigate(`/customer/merchant/${hash}`)}>
          <ShoppingBag size={16} /> {t("rewards.orderFrom", { store: card.store_name })}
        </Button>
      </motion.div>

      {rewards.length > 0 && (
        <motion.section variants={fadeSlideUp} className="mt-7">
          <SectionTitle>{t("rewards.yourRewards")}</SectionTitle>
          <RewardRail>
            {rewards.map((reward) => (
              <RewardTile key={reward.id} program={program} reward={reward} balance={card.balance} tier={card.tier} menu={menu} />
            ))}
          </RewardRail>
          <p className="mt-1 text-xs text-ink-400">{t("rewards.useAtCheckout")}</p>
        </motion.section>
      )}

      {program.tiers.length > 0 && (
        <motion.section variants={fadeSlideUp} className="mt-7">
          <SectionTitle>{t("rewards.status")}</SectionTitle>
          <TierLadder program={program} state={card.state} />
        </motion.section>
      )}

      <motion.section variants={fadeSlideUp} className="mt-7">
        <SectionTitle>{t("rewards.howYouEarn")}</SectionTitle>
        <HowYouEarn program={program} menu={menu} />
      </motion.section>

      <motion.section variants={fadeSlideUp} className="mt-7">
        <SectionTitle>{t("rewards.activity")}</SectionTitle>
        <Activity card={card} />
      </motion.section>
    </motion.div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-ink-400">{children}</h2>;
}

function lineLabel(line: PointsLine, t: ReturnType<typeof useT>): string {
  if ("Earn" in line.kind) return t("rewards.line.earn");
  if ("Redeem" in line.kind) return t("rewards.line.redeem");
  if ("Unspend" in line.kind) return t("rewards.line.unspend");
  return line.note ?? t("rewards.line.gift");
}

function Activity({ card }: { card: CardView }) {
  const t = useT();
  const program = card.program!.program;
  if (card.history.length === 0) return <p className="rounded-3xl bg-white p-5 text-sm text-ink-400 shadow-[var(--shadow-card)] dark:bg-ink-900">{t("rewards.noActivity")}</p>;
  const colors = ACCENTS[program.accent];
  return (
    <ul className="divide-y divide-ink-100 overflow-hidden rounded-3xl bg-white shadow-[var(--shadow-card)] dark:divide-ink-800 dark:bg-ink-900">
      {card.history.map((line) => (
        <li key={bytesToHex(line.entry)} className="flex items-center gap-3 px-5 py-3.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full" style={{ background: `${colors.from}22`, color: colors.to }}>
            {line.points < 0 ? <Gift size={14} /> : <Sparkles size={14} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{lineLabel(line, t)}</p>
            <p className="text-xs text-ink-400">{new Date(line.at / 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</p>
          </div>
          <span className={clsx("text-sm font-black tabular-nums", line.points < 0 ? "text-ink-500" : "")} style={line.points >= 0 ? { color: colors.to } : undefined}>
            {line.points > 0 ? "+" : ""}
            {line.points.toLocaleString()}
          </span>
        </li>
      ))}
    </ul>
  );
}

/// A store's program on its page: the customer's card at a glance, or what
/// joining earns -- linking to the full card.
export function StoreRewardsStrip({ catalogHex }: { catalogHex: string }) {
  const t = useT();
  const navigate = useNavigate();
  const { data: card } = useResource(`rewards:card:${catalogHex}`, () => myCard(hexToBytes(catalogHex)));
  if (!card?.program || !card.program.program.active) return null;
  const program = card.program.program;
  const colors = ACCENTS[program.accent];
  const tier = card.state ? tierOf(program, card.state) : 0;
  const next = [...program.rewards].filter((r) => r.min_tier <= tier && r.cost > card.balance).sort((a, b) => a.cost - b.cost)[0];
  const joined = card.state !== null;
  return (
    <motion.button
      type="button"
      variants={fadeSlideUp}
      whileTap={{ scale: 0.98 }}
      onClick={() => navigate(`/rewards/${catalogHex}`)}
      className="mt-4 flex w-full items-center gap-3 overflow-hidden rounded-2xl p-3.5 text-left text-white"
      style={{ backgroundImage: `linear-gradient(120deg, ${colors.from}, ${colors.to})`, boxShadow: `0 12px 28px -14px ${colors.glow}` }}
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/20">
        <Sparkles size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-black">{joined ? t("rewards.stripBalance", { points: card.balance.toLocaleString(), name: program.points_name }) : program.name}</p>
        <p className="truncate text-xs text-white/85">
          {joined
            ? next
              ? t("rewards.toNext", { points: (next.cost - card.balance).toLocaleString(), name: next.name })
              : t("rewards.allUnlocked")
            : program.earn.welcome_bonus > 0
              ? t("rewards.stripJoinWelcome", { points: program.earn.points_per_dollar, name: program.points_name, welcome: program.earn.welcome_bonus })
              : t("rewards.earnRate", { points: program.earn.points_per_dollar, name: program.points_name })}
        </p>
      </div>
      <ChevronRight size={18} className="shrink-0 text-white/80" />
    </motion.button>
  );
}
