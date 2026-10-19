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

type Open = "phrase" | "guardians" | "move" | "help" | "code" | "upgrade" | null;

export function AccountPage() {
  const agentPubKey = useSession((s) => s.agentPubKey);
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
        <Link to="/profile" aria-label="Back" className="grid h-9 w-9 place-items-center rounded-full bg-ink-100 text-ink-500 dark:bg-ink-800">
          <ArrowLeft size={18} />
        </Link>
        <h1 className="text-xl font-black tracking-tight text-ink-900 dark:text-ink-50">Account &amp; recovery</h1>
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
                <p className="text-sm font-bold text-ink-900 dark:text-ink-50">{protectedAccount ? "You can get your account back" : "Set up a way back in"}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
                  {protectedAccount
                    ? "If you lose this device, your recovery phrase or your guardians bring your account, history and balance to a new one."
                    : "Your account lives on this device. There's no company that can reset it, so if you lose the device without a recovery phrase or guardians, the account and its balance are gone."}
                </p>
              </div>
            </div>
          )}
        </Card>
      </motion.div>

      {docket && docket.length > 0 && (
        <motion.div variants={fadeSlideUp}>
          <Section title="Arbiter">
            <Row icon={<Gavel size={18} />} title="Appeals" detail={`${docket.filter((a) => !a.ruling).length} waiting for your ruling`} onClick={() => navigate("/arbitrate")} />
          </Section>
        </motion.div>
      )}

      {isVerifier && (
        <motion.div variants={fadeSlideUp}>
          <Section title="Verifier">
            <Row icon={<ShieldCheck size={18} />} title="Verify a driver" detail="Scan a driver's code after checking their documents" onClick={() => navigate("/verify")} />
          </Section>
        </motion.div>
      )}

      {next && (
        <motion.div variants={fadeSlideUp}>
          <Section title="New version">
            <Row icon={<Sparkles size={18} />} title="Move to the new version of Relay" detail="Your account, balance, stores and history come with you" onClick={() => setOpen("upgrade")} />
          </Section>
        </motion.div>
      )}

      <motion.div variants={fadeSlideUp}>
        <Section title="Ways back in">
          <Row
            icon={<KeyRound size={18} />}
            title="Recovery phrase"
            detail={hasPhrase ? `Set up ${new Date(plan!.published_at / 1000).toLocaleDateString()}` : "Twelve words you write down"}
            badge={hasPhrase ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
            onClick={() => setOpen("phrase")}
          />
          <Row
            icon={<Users size={18} />}
            title="Guardians"
            detail={
              guardianCount > 0
                ? `${plan!.guardians.map((g) => names[encodeHashToBase64(g)] || keyFingerprint(g)).join(", ")} · any ${plan!.threshold} can vouch`
                : "People you trust vouch for you"
            }
            badge={guardianCount > 0 ? <Badge tone="success">{guardianCount}</Badge> : <Badge>Off</Badge>}
            onClick={() => setOpen("guardians")}
          />
        </Section>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Section title="This device">
          <Row icon={<Smartphone size={18} />} title="Move to a new device" detail="Your account, balance and history go with you" onClick={() => setOpen("move")} />
          <Row icon={<QrCode size={18} />} title="Your account code" detail="Show it to someone making you their guardian" onClick={() => setOpen("code")} />
        </Section>
      </motion.div>

      <motion.div variants={fadeSlideUp}>
        <Section title="People you guard">
          {wards === undefined ? (
            <div className="p-4">
              <Skeleton className="h-10 w-full" />
            </div>
          ) : wards.length === 0 ? (
            <p className="p-4 text-sm text-ink-400">Nobody has made you a guardian yet. They'd scan your account code.</p>
          ) : (
            <>
              {wards.map((ward) => (
                <WardRow key={bytesToHex(ward.account)} ward={ward} />
              ))}
              <Row icon={<HeartHandshake size={18} />} title="Help someone recover" detail="Vouch for their new device" onClick={() => setOpen("help")} />
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
        <Sheet open onClose={close} title="Your account code" subtitle="Someone making you their guardian scans this.">
          <AccountCode agent={agentPubKey} note="Read the fingerprint aloud so they can check it matches what their screen shows." />
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
  return named || profile?.display_name || `Account ${keyFingerprint(agent)}`;
}

function WardRow({ ward }: { ward: PlanView }) {
  const name = useDisplayName(ward.account);
  return (
    <div className="flex items-center gap-3 p-4">
      <HeartHandshake size={18} className="text-ink-400" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{name}</p>
        <p className="text-xs text-ink-400">
          One of {ward.guardians.length} guardians · {ward.threshold} needed
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
  // Made once, kept only in memory while the sheet is open.
  const [phrase] = useState(() => newPhrase());
  const [asked] = useState(() => pickPositions(phrase.length, WORDS_CHECKED));
  const [answers, setAnswers] = useState<string[]>(() => asked.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replacing = !!plan?.phrase_key;

  async function save() {
    if (asked.some((position, i) => answers[i].trim().toLowerCase() !== phrase[position].toLowerCase())) {
      setError("Those words don't match. Check what you wrote down.");
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
      title="Recovery phrase"
      subtitle={step === "check" ? "Type these words from what you wrote down." : "Twelve words that bring your account back on any device."}
      footer={
        <>
          {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          {step === "intro" && (
            <>
              <Button className="w-full" onClick={() => setStep("words")}>
                {replacing ? "Make a new phrase" : "Show my words"}
              </Button>
              {replacing && (
                <button type="button" onClick={turnOff} disabled={busy} className="mt-3 w-full text-center text-xs font-semibold text-red-600">
                  Turn the recovery phrase off
                </button>
              )}
            </>
          )}
          {step === "words" && (
            <Button className="w-full" onClick={() => setStep("check")}>
              I've written them down
            </Button>
          )}
          {step === "check" && (
            <Button className="w-full" loading={busy} disabled={answers.some((a) => !a.trim())} onClick={save}>
              {replacing ? "Replace my recovery phrase" : "Turn on my recovery phrase"}
            </Button>
          )}
        </>
      }
    >
      {step === "intro" && (
        <ul className="flex flex-col gap-3 text-sm text-ink-600 dark:text-ink-300">
          <li>Write the words on paper and keep it somewhere safe. Don't screenshot them or store them online.</li>
          <li>Anyone with the words can take over your account and its balance. Nobody from Relay will ever ask for them.</li>
          {replacing && <li className="font-semibold">Your old phrase stops working as soon as you save the new one.</li>}
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
            <Field key={position} label={`Word ${position + 1}`}>
              <Input
                aria-label={`Word ${position + 1}`}
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
  const [guardians, setGuardians] = useState<AgentPubKey[]>(plan?.guardians ?? []);
  const [threshold, setThreshold] = useState(plan?.threshold || 1);
  const [adding, setAdding] = useState<AgentPubKey | "scan" | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const same = (a: AgentPubKey, b: AgentPubKey) => bytesToHex(a) === bytesToHex(b);

  function scanned(key: AgentPubKey) {
    setError(null);
    if (same(key, me)) return setError("That's your own code: scan your guardian's.");
    if (guardians.some((g) => same(g, key))) return setError("They're already one of your guardians.");
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
      <Sheet open onClose={() => setAdding(null)} title="Add a guardian" subtitle={adding === "scan" ? "Scan the account code on their phone (Profile → Account & recovery)." : "Check it's really them."}>
        {adding === "scan" ? (
          <>
            {error && <p className="mb-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
            <AccountCodeReader onKey={scanned} prompt="Point at your guardian's account code" />
          </>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="rounded-2xl bg-ink-50 p-4 text-center dark:bg-ink-800">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">Fingerprint</p>
              <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{keyFingerprint(adding)}</p>
              <p className="mt-1 text-xs text-ink-500">It should match the one on their screen.</p>
            </div>
            <Field label="What do you call them?">
              <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Sam" />
            </Field>
            <p className="text-xs text-ink-400">Only you see this name.</p>
            <Button disabled={!newName.trim()} onClick={add}>
              Add {newName.trim() || "guardian"}
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
      title="Guardians"
      subtitle="If you lose your device, enough of them vouch for your new one -- after you've spoken, so they know it's you."
      footer={
        <>
          {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          <Button className="w-full" loading={busy} onClick={save}>
            Save guardians
          </Button>
        </>
      }
    >
      <ul className="mb-3 flex flex-col gap-2">
        {guardians.map((g) => (
          <li key={bytesToHex(g)} className="flex items-center gap-3 rounded-2xl border border-ink-100 p-3 dark:border-ink-800">
            <Users size={16} className="text-ink-400" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink-900 dark:text-ink-50">{names[encodeHashToBase64(g)] || "Guardian"}</span>
              <span className="block font-mono text-xs text-ink-400">{keyFingerprint(g)}</span>
            </span>
            <button
              type="button"
              aria-label="Remove"
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
          <UserPlus size={16} /> Add a guardian
        </Button>
      )}
      {guardians.length > 0 && (
        <Field label="How many must vouch" className="mt-4">
          <Select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
            {guardians.map((_, i) => (
              <option key={i} value={i + 1}>
                {i + 1} of {guardians.length}
                {i + 1 > guardians.length / 2 ? "" : " (fewer than half: easier, less safe)"}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <p className="mt-3 text-xs leading-relaxed text-ink-400">
        Pick people who know you and use Relay. They can't touch your account on their own: only enough of them together, for a device you're recovering onto.
      </p>
    </Sheet>
  );
}

function MoveSheet({ me, onClose }: { me: AgentPubKey; onClose: () => void }) {
  const merchant = useSession((s) => !!s.profile?.roles.includes("Merchant"));
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
      title="Move to a new device"
      subtitle={successor ? "Check the fingerprint matches your new device." : "On your new device, open Relay and choose “I already have an account”, then “From my other device”. Scan the code it shows."}
      footer={
        successor ? (
          <>
            {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
            <Button className="w-full" loading={busy} onClick={move}>
              Move my account
            </Button>
          </>
        ) : undefined
      }
    >
      {successor ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl bg-ink-50 p-4 text-center dark:bg-ink-800">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">New device</p>
            <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{keyFingerprint(successor)}</p>
          </div>
          <ul className="flex flex-col gap-2 text-sm text-ink-600 dark:text-ink-300">
            <li>Your balance, name, phone, saved addresses and favourites go to the new device, sealed so only it can read them.</li>
            <li>Your ratings and history follow you.</li>
            {merchant && <li>Your stores move too: their listings close here, and you list them again from your new phone.</li>}
            <li className="font-semibold">This device stops working for Relay once you move. Finish any orders in progress first.</li>
          </ul>
        </div>
      ) : (
        <AccountCodeReader
          prompt="Point at the code on your new device"
          onKey={(key) => (bytesToHex(key) === bytesToHex(me) ? setError("That's this device's own code.") : setSuccessor(key))}
        />
      )}
      {!successor && error && <p className="mt-2 text-center text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Sheet>
  );
}

function HelpRecoverSheet({ wards, me, onClose }: { wards: PlanView[]; me: AgentPubKey; onClose: () => void }) {
  const [successor, setSuccessor] = useState<AgentPubKey | null>(null);
  const [wardHex, setWardHex] = useState(wards.length === 1 ? bytesToHex(wards[0].account) : "");
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
      <Sheet open onClose={onClose} title="You've vouched" subtitle="Their new device picks it up on its own.">
        <p className="text-sm text-ink-600 dark:text-ink-300">Once enough of their guardians have vouched, their account moves to the new device.</p>
      </Sheet>
    );
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Help someone recover"
      subtitle={successor ? "Only vouch once you're sure it's them." : "Ask them for the code on their new device's screen."}
      footer={
        successor ? (
          <>
            {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
            <Button className="w-full" loading={busy} disabled={!ward || !spoken} onClick={vouchForThem}>
              Vouch for this device
            </Button>
          </>
        ) : undefined
      }
    >
      {successor ? (
        <div className="flex flex-col gap-4">
          {wards.length > 1 && (
            <Field label="Who is recovering?">
              <Select value={wardHex} onChange={(e) => setWardHex(e.target.value)}>
                <option value="">Choose…</option>
                {wards.map((w) => (
                  <WardOption key={bytesToHex(w.account)} ward={w} />
                ))}
              </Select>
            </Field>
          )}
          <div className="rounded-2xl bg-ink-50 p-4 text-center dark:bg-ink-800">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">Their new device</p>
            <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{keyFingerprint(successor)}</p>
            <p className="mt-1 text-xs text-ink-500">Ask them to read out the fingerprint on their screen. It should match.</p>
          </div>
          <label className="flex items-start gap-2 text-sm text-ink-600 dark:text-ink-300">
            <Checkbox checked={spoken} onChange={(e) => setSpoken(e.target.checked)} className="mt-0.5" />
            I've spoken to them myself, in person or by a call I know is them, and they asked me to vouch for this device.
          </label>
          <p className="text-xs text-ink-400">Someone pretending to be them could take their account and its balance. A message or email alone isn't enough.</p>
        </div>
      ) : (
        <AccountCodeReader
          prompt="Point at the code on their new device"
          onKey={(key) => (bytesToHex(key) === bytesToHex(me) ? setError("That's your own code.") : setSuccessor(key))}
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
      title="Move to the new version"
      subtitle={successor ? "Check the fingerprint matches the new version." : "Install the new version of Relay, open it, choose “I already have an account”, then “From the previous version”. Scan the code it shows."}
      footer={
        successor ? (
          <>
            {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
            <Button className="w-full" loading={busy} onClick={move}>
              Move my account
            </Button>
          </>
        ) : undefined
      }
    >
      {successor ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl bg-ink-50 p-4 text-center dark:bg-ink-800">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">New version</p>
            <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{keyFingerprint(successor)}</p>
          </div>
          <ul className="flex flex-col gap-2 text-sm text-ink-600 dark:text-ink-300">
            <li>Your balance is carried over by the network's issuer within a few minutes.</li>
            <li>Your name, phone, saved addresses, favourites, stores and ratings come with you.</li>
            <li className="font-semibold">This version stops working for your account once you move. Finish any orders in progress first.</li>
          </ul>
        </div>
      ) : (
        <AccountCodeReader prompt="Point at the code in the new version" onKey={(key) => (bytesToHex(key) === bytesToHex(me) ? setError("That's this version's own code.") : setSuccessor(key))} />
      )}
      {!successor && error && <p className="mt-2 text-center text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Sheet>
  );
}
