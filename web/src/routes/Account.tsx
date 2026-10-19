// Account & recovery: how this person gets their account back if they lose
// this device -- their recovery phrase, and guardians -- moving it to a new
// device, and helping the people they guard recover theirs. No company can
// reset anyone's account here: these are the only ways back in, so this
// screen says plainly which are set up. See RECOVERY.md.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getMyDocket, getVerificationTerms } from "../holochain/zomes/dispatch";
import { motion } from "framer-motion";
import { encodeHashToBase64 } from "@holochain/client";
import { ArrowLeft, ChevronRight, Gavel, HeartHandshake, KeyRound, QrCode, ShieldAlert, ShieldCheck, Smartphone, Sparkles, Trash2, UserPlus, Users } from "lucide-react";
import type { AgentPubKey, PlanView } from "../holochain/types";
import { bytesToHex } from "../holochain/decode";
import { handOver, migrateOut, myRecoveryPlan, myWards, setRecoveryPlan, vouch } from "../holochain/zomes/account";
import { nextNetwork } from "../lib/migration";
import { MAX_GUARDIANS } from "../holochain/types";
import { fetchProfile } from "../holochain/zomes/profiles";
import { closeListing, isStoreListed, listMyCatalogs } from "../holochain/zomes/catalog";
import { AccountCode, AccountCodeReader } from "../components/AccountCode";
import { Sheet } from "../components/Sheet";
import { Badge, Button, Card, Checkbox, Field, Input, Select, Skeleton } from "../components/ui";
import { keyFingerprint, packParcel } from "../lib/accountMove";
import { describeError } from "../lib/errors";
import { fadeSlideUp, staggerContainer } from "../lib/motion";
import { POLL } from "../lib/poll";
import { newPhrase, phraseKey } from "../lib/recoveryPhrase";
import { useResource } from "../lib/useResource";
import { useGuardianNames } from "../store/guardianNames";
import { useSession } from "../store/session";
import { t as translate, useT } from "../i18n";
import { formatDate } from "../lib/format";

type Open = "phrase" | "guardians" | "move" | "help" | "code" | "upgrade" | null;

export function AccountPage() {
  const agentPubKey = useSession((s) => s.agentPubKey);
  const t = useT();
  const hex = agentPubKey ? bytesToHex(agentPubKey) : null;
  const { data: plan, reload } = useResource(hex && `plan:${hex}`, myRecoveryPlan);
  const { data: wards } = useResource(hex && `wards:${hex}`, myWards, { pollMs: POLL.slow });
  const [open, setOpen] = useState<Open>(null);
  const navigate = useNavigate();
  const names = useGuardianNames((s) => s.names);
  // A new version of the network, once an issuer announces it (MIGRATION.md).
  const { data: next } = useResource("next-network", nextNetwork, { pollMs: POLL.slow });
  const { data: verification } = useResource("verification-terms", getVerificationTerms);
  const isVerifier = !!verification?.verifiers.some((v) => bytesToHex(v) === hex);
  // An arbiter has a docket; nobody else's ever has anything on it.
  const { data: docket } = useResource("docket", getMyDocket, { pollMs: POLL.slow });

  if (!agentPubKey) return null;
  const hasPhrase = !!plan?.phrase_key;
  const guardianCount = plan?.guardians.length ?? 0;
  const protectedAccount = hasPhrase || guardianCount > 0;
  const close = () => setOpen(null);
  const saved = async () => {
    setOpen(null);
    await reload();
  };

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="visible" className="px-4 pb-10 pt-4">
      <motion.div variants={fadeSlideUp} className="mb-4 flex items-center gap-2">
        <Link to="/profile" aria-label={t("common.back")} className="grid h-9 w-9 place-items-center rounded-full bg-ink-100 text-ink-500 dark:bg-ink-800">
          <ArrowLeft size={18} />
        </Link>
        <h1 className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">{t("profile.account")}</h1>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Card className="mb-4 p-5">
          {plan === undefined ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div className="flex items-start gap-3">
              <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${protectedAccount ? "bg-presence-100 text-presence-600 dark:bg-presence-900/30" : "bg-amber-100 text-amber-600 dark:bg-amber-900/30"}`}>
                {protectedAccount ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />}
              </span>
              <div>
                <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{protectedAccount ? t("account.protected") : t("account.unprotected")}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
                  {protectedAccount ? t("account.protectedDetail") : t("account.unprotectedDetail")}
                </p>
              </div>
            </div>
          )}
        </Card>
      </motion.div>

      {docket && docket.length > 0 && (
        <motion.div variants={fadeSlideUp}>
          <Section title={t("account.arbiter")}>
            <Row icon={<Gavel size={18} />} title={t("account.appeals")} detail={t("account.waitingRuling", { count: docket.filter((a) => !a.ruling).length })} onClick={() => navigate("/arbitrate")} />
          </Section>
        </motion.div>
      )}

      {isVerifier && (
        <motion.div variants={fadeSlideUp}>
          <Section title={t("account.verifier")}>
            <Row icon={<ShieldCheck size={18} />} title={t("verify.title")} detail={t("account.verifyDetail")} onClick={() => navigate("/verify")} />
          </Section>
        </motion.div>
      )}

      {next && (
        <motion.div variants={fadeSlideUp}>
          <Section title={t("account.newVersion")}>
            <Row icon={<Sparkles size={18} />} title={t("account.upgrade")} detail={t("account.upgradeDetail")} onClick={() => setOpen("upgrade")} />
          </Section>
        </motion.div>
      )}

      <motion.div variants={fadeSlideUp}>
        <Section title={t("account.waysBack")}>
          <Row
            icon={<KeyRound size={18} />}
            title={t("account.phrase")}
            detail={hasPhrase ? t("account.setUpOn", { date: formatDate(plan!.published_at) }) : t("account.phraseDetail")}
            badge={hasPhrase ? <Badge tone="success">{t("account.on")}</Badge> : <Badge>{t("account.off")}</Badge>}
            onClick={() => setOpen("phrase")}
          />
          <Row
            icon={<Users size={18} />}
            title={t("account.guardians")}
            detail={
              guardianCount > 0
                ? `${plan!.guardians.map((g) => names[encodeHashToBase64(g)] || keyFingerprint(g)).join(", ")} · ${t("account.anyCanVouch", { count: plan!.threshold })}`
                : t("account.guardiansDetail")
            }
            badge={guardianCount > 0 ? <Badge tone="success">{guardianCount}</Badge> : <Badge>{t("account.off")}</Badge>}
            onClick={() => setOpen("guardians")}
          />
        </Section>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Section title={t("account.thisDevice")}>
          <Row icon={<Smartphone size={18} />} title={t("account.move")} detail={t("account.moveDetail")} onClick={() => setOpen("move")} />
          <Row icon={<QrCode size={18} />} title={t("account.code")} detail={t("account.codeDetail")} onClick={() => setOpen("code")} />
        </Section>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Section title={t("account.wards")}>
          {wards === undefined ? (
            <div className="p-4">
              <Skeleton className="h-10 w-full" />
            </div>
          ) : wards.length === 0 ? (
            <p className="p-4 text-sm text-ink-400">{t("account.noWards")}</p>
          ) : (
            <>
              {wards.map((ward) => (
                <WardRow key={bytesToHex(ward.account)} ward={ward} />
              ))}
              <Row icon={<HeartHandshake size={18} />} title={t("account.help")} detail={t("account.helpDetail")} onClick={() => setOpen("help")} />
            </>
          )}
        </Section>
      </motion.div>

      {open === "phrase" && <PhraseSheet plan={plan ?? null} onClose={close} onSaved={saved} />}
      {open === "guardians" && <GuardiansSheet plan={plan ?? null} me={agentPubKey} onClose={close} onSaved={saved} />}
      {open === "move" && <MoveSheet me={agentPubKey} onClose={close} />}
      {open === "upgrade" && next && <UpgradeSheet me={agentPubKey} next={next} onClose={close} />}
      {open === "help" && wards && <HelpRecoverSheet wards={wards} me={agentPubKey} onClose={close} />}
      {open === "code" && (
        <Sheet open onClose={close} title={t("account.code")} subtitle={t("account.codeSubtitle")}>
          <AccountCode agent={agentPubKey} note={t("account.codeNote")} />
        </Sheet>
      )}
    </motion.div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">{title}</p>
      <Card className="divide-y divide-ink-100 overflow-hidden dark:divide-ink-800">{children}</Card>
    </div>
  );
}

function Row({ icon, title, detail, badge, onClick }: { icon: React.ReactNode; title: string; detail: string; badge?: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-ink-50 dark:hover:bg-ink-800/50">
      <span className="text-ink-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink-900 dark:text-ink-50">{title}</span>
        <span className="block truncate text-xs text-ink-400">{detail}</span>
      </span>
      {badge}
      <ChevronRight size={16} className="shrink-0 text-ink-300" />
    </button>
  );
}

/// What to call someone: the name given them on this device, their public
/// name, or their key's fingerprint.
function useDisplayName(agent: AgentPubKey): string {
  const named = useGuardianNames((s) => s.names[encodeHashToBase64(agent)]);
  const { data: profile } = useResource(named ? null : `profile:${bytesToHex(agent)}`, () => fetchProfile(agent));
  return named || profile?.display_name || translate("account.named", { fingerprint: keyFingerprint(agent) });
}

function WardRow({ ward }: { ward: PlanView }) {
  const name = useDisplayName(ward.account);
  const t = useT();
  return (
    <div className="flex items-center gap-3 p-4">
      <HeartHandshake size={18} className="text-ink-400" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{name}</p>
        <p className="text-xs text-ink-400">
          {t("account.wardDetail", { count: ward.guardians.length, needed: ward.threshold })}
        </p>
      </div>
    </div>
  );
}

/// A plan with one part replaced, the rest as it was.
function planWith(plan: PlanView | null, change: { phrase_key?: AgentPubKey | null; guardians?: AgentPubKey[]; threshold?: number }) {
  const guardians = change.guardians ?? plan?.guardians ?? [];
  return {
    phrase_key: change.phrase_key === undefined ? (plan?.phrase_key ?? null) : change.phrase_key,
    guardians,
    threshold: guardians.length === 0 ? 0 : Math.min(change.threshold ?? plan?.threshold ?? 1, guardians.length),
  };
}

/// How many of the twelve words are asked back.
const WORDS_CHECKED = 3;

function PhraseSheet({ plan, onClose, onSaved }: { plan: PlanView | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [step, setStep] = useState<"intro" | "words" | "check">("intro");
  const t = useT();
  // Made once, kept only in memory while the sheet is open.
  const [phrase] = useState(() => newPhrase());
  const [asked] = useState(() => pickPositions(phrase.length, WORDS_CHECKED));
  const [answers, setAnswers] = useState<string[]>(() => asked.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replacing = !!plan?.phrase_key;

  async function save() {
    if (asked.some((position, i) => answers[i].trim().toLowerCase() !== phrase[position].toLowerCase())) {
      setError(t("account.phraseMismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setRecoveryPlan(planWith(plan, { phrase_key: phraseKey(phrase).publicKey }));
      await onSaved();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      await setRecoveryPlan(planWith(plan, { phrase_key: null }));
      await onSaved();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("account.phrase")}
      subtitle={step === "check" ? t("account.phraseCheck") : t("account.phraseSubtitle")}
      footer={
        <>
          {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          {step === "intro" && (
            <>
              <Button className="w-full" onClick={() => setStep("words")}>
                {replacing ? t("account.newPhrase") : t("account.showWords")}
              </Button>
              {replacing && (
                <button type="button" onClick={turnOff} disabled={busy} className="mt-3 w-full text-center text-xs font-semibold text-red-600">
                  {t("account.phraseOff")}
                </button>
              )}
            </>
          )}
          {step === "words" && (
            <Button className="w-full" onClick={() => setStep("check")}>
              {t("account.written")}
            </Button>
          )}
          {step === "check" && (
            <Button className="w-full" loading={busy} disabled={answers.some((a) => !a.trim())} onClick={save}>
              {replacing ? t("account.replacePhrase") : t("account.turnOnPhrase")}
            </Button>
          )}
        </>
      }
    >
      {step === "intro" && (
        <ul className="flex flex-col gap-3 text-sm text-ink-600 dark:text-ink-300">
          <li>{t("account.phraseTip1")}</li>
          <li>{t("account.phraseTip2")}</li>
          {replacing && <li className="font-semibold">{t("account.phraseTip3")}</li>}
        </ul>
      )}
      {step === "words" && (
        <ol className="grid grid-cols-2 gap-2">
          {phrase.map((word, i) => (
            <li key={i} className="flex items-baseline gap-2 rounded-xl bg-ink-50 px-3 py-2 dark:bg-ink-800">
              <span className="w-5 text-right text-xs tabular-nums text-ink-400">{i + 1}</span>
              <span className="font-mono text-sm font-semibold text-ink-900 dark:text-ink-50">{word}</span>
            </li>
          ))}
        </ol>
      )}
      {step === "check" && (
        <div className="flex flex-col gap-3">
          {asked.map((position, i) => (
            <Field key={position} label={t("account.word", { n: position + 1 })}>
              <Input
                aria-label={t("account.word", { n: position + 1 })}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                value={answers[i]}
                onChange={(e) => setAnswers((prev) => prev.map((a, j) => (j === i ? e.target.value : a)))}
              />
            </Field>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/// `count` distinct positions below `length`, in order.
function pickPositions(length: number, count: number): number[] {
  const positions = new Set<number>();
  const random = new Uint32Array(1);
  while (positions.size < count) {
    crypto.getRandomValues(random);
    positions.add(random[0] % length);
  }
  return [...positions].sort((a, b) => a - b);
}

function GuardiansSheet({ plan, me, onClose, onSaved }: { plan: PlanView | null; me: AgentPubKey; onClose: () => void; onSaved: () => Promise<void> }) {
  const { names, setName } = useGuardianNames();
  const t = useT();
  const [guardians, setGuardians] = useState<AgentPubKey[]>(plan?.guardians ?? []);
  const [threshold, setThreshold] = useState(plan?.threshold || 1);
  const [adding, setAdding] = useState<AgentPubKey | "scan" | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const same = (a: AgentPubKey, b: AgentPubKey) => bytesToHex(a) === bytesToHex(b);

  function scanned(key: AgentPubKey) {
    setError(null);
    if (same(key, me)) return setError(t("account.ownCodeGuardian"));
    if (guardians.some((g) => same(g, key))) return setError(t("account.alreadyGuardian"));
    setAdding(key);
  }

  function add() {
    if (!(adding instanceof Uint8Array)) return;
    setName(encodeHashToBase64(adding), newName);
    const next = [...guardians, adding];
    setGuardians(next);
    // More than half, by default: two recoveries of one account would need
    // a guardian on both sides.
    setThreshold(Math.floor(next.length / 2) + 1);
    setAdding(null);
    setNewName("");
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await setRecoveryPlan(planWith(plan, { guardians, threshold }));
      await onSaved();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  if (adding !== null) {
    return (
      <Sheet open onClose={() => setAdding(null)} title={t("account.addGuardian")} subtitle={adding === "scan" ? t("account.scanGuardian") : t("account.checkThem")}>
        {adding === "scan" ? (
          <>
            {error && <p className="mb-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
            <AccountCodeReader onKey={scanned} prompt={t("account.pointGuardian")} />
          </>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="rounded-2xl bg-ink-50 p-4 text-center dark:bg-ink-800">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">{t("code.fingerprint")}</p>
              <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{keyFingerprint(adding)}</p>
              <p className="mt-1 text-xs text-ink-500">{t("account.shouldMatch")}</p>
            </div>
            <Field label={t("account.callThem")}>
              <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} />
            </Field>
            <p className="text-xs text-ink-400">{t("account.onlyYou")}</p>
            <Button disabled={!newName.trim()} onClick={add}>
              {t("account.addNamed", { name: newName.trim() || t("account.guardian") })}
            </Button>
          </div>
        )}
      </Sheet>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("account.guardians")}
      subtitle={t("account.guardiansSubtitle")}
      footer={
        <>
          {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          <Button className="w-full" loading={busy} onClick={save}>
            {t("account.saveGuardians")}
          </Button>
        </>
      }
    >
      <ul className="mb-3 flex flex-col gap-2">
        {guardians.map((g) => (
          <li key={bytesToHex(g)} className="flex items-center gap-3 rounded-2xl border border-ink-100 p-3 dark:border-ink-800">
            <Users size={16} className="text-ink-400" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{names[encodeHashToBase64(g)] || t("account.guardianCap")}</span>
              <span className="block font-mono text-xs text-ink-400">{keyFingerprint(g)}</span>
            </span>
            <button
              type="button"
              aria-label={t("common.remove")}
              onClick={() => {
                const next = guardians.filter((x) => !same(x, g));
                setGuardians(next);
                setThreshold(Math.max(1, Math.min(threshold, next.length)));
              }}
              className="text-ink-300 hover:text-red-500"
            >
              <Trash2 size={16} />
            </button>
          </li>
        ))}
      </ul>
      {guardians.length < MAX_GUARDIANS && (
        <Button variant="ghost" className="w-full" onClick={() => setAdding("scan")}>
          <UserPlus size={16} /> {t("account.addGuardian")}
        </Button>
      )}
      {guardians.length > 0 && (
        <Field label={t("account.howMany")} className="mt-4">
          <Select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
            {guardians.map((_, i) => (
              <option key={i} value={i + 1}>
                {t("account.ofCount", { n: i + 1, count: guardians.length })}
                {i + 1 > guardians.length / 2 ? "" : ` ${t("account.fewerThanHalf")}`}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <p className="mt-3 text-xs leading-relaxed text-ink-400">
        {t("account.pickPeople")}
      </p>
    </Sheet>
  );
}

function MoveSheet({ me, onClose }: { me: AgentPubKey; onClose: () => void }) {
  const merchant = useSession((s) => !!s.profile?.roles.includes("Merchant"));
  const t = useT();
  const [successor, setSuccessor] = useState<AgentPubKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function move() {
    if (!successor) return;
    setBusy(true);
    setError(null);
    try {
      // A listed store's stake comes back only to this key: its listing
      // closes here, and the new phone lists the moved store again.
      for (const store of await listMyCatalogs()) {
        if (await isStoreListed(store.original_action)) await closeListing(store.original_action);
      }
      await handOver(successor, await packParcel());
      // This key is done: the app shows so, from here on.
      useSession.setState({ movedTo: successor });
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("account.move")}
      subtitle={successor ? t("account.checkNewDevice") : t("account.moveHow")}
      footer={
        successor ? (
          <>
            {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
            <Button className="w-full" loading={busy} onClick={move}>
              {t("account.moveMine")}
            </Button>
          </>
        ) : undefined
      }
    >
      {successor ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl bg-ink-50 p-4 text-center dark:bg-ink-800">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">{t("account.newDevice")}</p>
            <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{keyFingerprint(successor)}</p>
          </div>
          <ul className="flex flex-col gap-2 text-sm text-ink-600 dark:text-ink-300">
            <li>{t("account.moveWhat1")}</li>
            <li>{t("account.moveWhat2")}</li>
            {merchant && <li>{t("account.moveStores")}</li>}
            <li className="font-semibold">{t("account.moveStops")}</li>
          </ul>
        </div>
      ) : (
        <AccountCodeReader
          prompt={t("account.pointNewDevice")}
          onKey={(key) => (bytesToHex(key) === bytesToHex(me) ? setError(t("account.thisDeviceCode")) : setSuccessor(key))}
        />
      )}
      {!successor && error && <p className="mt-2 text-center text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Sheet>
  );
}

function HelpRecoverSheet({ wards, me, onClose }: { wards: PlanView[]; me: AgentPubKey; onClose: () => void }) {
  const [successor, setSuccessor] = useState<AgentPubKey | null>(null);
  const [wardHex, setWardHex] = useState(wards.length === 1 ? bytesToHex(wards[0].account) : "");
  const t = useT();
  const [spoken, setSpoken] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ward = wards.find((w) => bytesToHex(w.account) === wardHex);

  async function vouchForThem() {
    if (!ward || !successor) return;
    setBusy(true);
    setError(null);
    try {
      await vouch(ward.account, successor);
      setDone(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Sheet open onClose={onClose} title={t("account.vouched")} subtitle={t("account.vouchedSubtitle")}>
        <p className="text-sm text-ink-600 dark:text-ink-300">{t("account.vouchedDetail")}</p>
      </Sheet>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("account.help")}
      subtitle={successor ? t("account.onlyIfSure") : t("account.askCode")}
      footer={
        successor ? (
          <>
            {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
            <Button className="w-full" loading={busy} disabled={!ward || !spoken} onClick={vouchForThem}>
              {t("account.vouch")}
            </Button>
          </>
        ) : undefined
      }
    >
      {successor ? (
        <div className="flex flex-col gap-4">
          {wards.length > 1 && (
            <Field label={t("account.whoRecovering")}>
              <Select value={wardHex} onChange={(e) => setWardHex(e.target.value)}>
                <option value="">{t("account.choose")}</option>
                {wards.map((w) => (
                  <WardOption key={bytesToHex(w.account)} ward={w} />
                ))}
              </Select>
            </Field>
          )}
          <div className="rounded-2xl bg-ink-50 p-4 text-center dark:bg-ink-800">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">{t("account.theirDevice")}</p>
            <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{keyFingerprint(successor)}</p>
            <p className="mt-1 text-xs text-ink-500">{t("account.readFingerprint")}</p>
          </div>
          <label className="flex items-start gap-2 text-sm text-ink-600 dark:text-ink-300">
            <Checkbox checked={spoken} onChange={(e) => setSpoken(e.target.checked)} className="mt-0.5" />
            {t("account.spoken")}
          </label>
          <p className="text-xs text-ink-400">{t("account.impersonation")}</p>
        </div>
      ) : (
        <AccountCodeReader
          prompt={t("account.pointTheirDevice")}
          onKey={(key) => (bytesToHex(key) === bytesToHex(me) ? setError(t("account.ownCode")) : setSuccessor(key))}
        />
      )}
      {!successor && error && <p className="mt-2 text-center text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Sheet>
  );
}

function WardOption({ ward }: { ward: PlanView }) {
  return <option value={bytesToHex(ward.account)}>{useDisplayName(ward.account)}</option>;
}

/// Moving the account to the new version of Relay (MIGRATION.md): the new
/// version, installed on this device or another, shows its code; this one
/// seals what's private to it, records the move and closes its chain here.
/// The issuer carries the balance over.
function UpgradeSheet({ me, next, onClose }: { me: AgentPubKey; next: { network: Uint8Array; issuer: AgentPubKey }; onClose: () => void }) {
  const t = useT();
  const [successor, setSuccessor] = useState<AgentPubKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function move() {
    if (!successor) return;
    setBusy(true);
    setError(null);
    try {
      // A listed store's stake comes back only to this key: its listing
      // closes here, and the new version lists the store again.
      for (const store of await listMyCatalogs()) {
        if (await isStoreListed(store.original_action)) await closeListing(store.original_action);
      }
      await migrateOut({ network: next.network, successor, issuer: next.issuer, parcel: await packParcel() });
      useSession.setState({ movedToNewVersion: true });
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("account.upgradeTitle")}
      subtitle={successor ? t("account.checkNewVersion") : t("account.upgradeHow")}
      footer={
        successor ? (
          <>
            {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
            <Button className="w-full" loading={busy} onClick={move}>
              {t("account.moveMine")}
            </Button>
          </>
        ) : undefined
      }
    >
      {successor ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl bg-ink-50 p-4 text-center dark:bg-ink-800">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">{t("account.newVersion")}</p>
            <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{keyFingerprint(successor)}</p>
          </div>
          <ul className="flex flex-col gap-2 text-sm text-ink-600 dark:text-ink-300">
            <li>{t("account.upgradeWhat1")}</li>
            <li>{t("account.upgradeWhat2")}</li>
            <li className="font-semibold">{t("account.upgradeStops")}</li>
          </ul>
        </div>
      ) : (
        <AccountCodeReader prompt={t("account.pointNewVersion")} onKey={(key) => (bytesToHex(key) === bytesToHex(me) ? setError(t("account.thisVersionCode")) : setSuccessor(key))} />
      )}
      {!successor && error && <p className="mt-2 text-center text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Sheet>
  );
}
