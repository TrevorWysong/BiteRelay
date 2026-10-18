// "I already have an account": bringing an existing account onto this
// device. Three ways, each ending with this device's key taking the account
// over (the account zome's `take_over`), then the person confirming their
// details:
//
//   - from their other device, which scans this one's code and hands over;
//   - with their recovery phrase, which signs for this key;
//   - with their guardians, who scan this one's code and vouch.
//
// This device's key is made (and, in development, remembered) first, so the
// code it shows stays the same across reloads -- guardians may take days.
// Waiting is polled, not pushed: nothing tells a new device it's been
// handed an account.
import { useState } from "react";
import { ArrowLeft, HeartHandshake, History, KeyRound, Smartphone } from "lucide-react";
import type { AgentPubKey, PlanView, VouchView } from "../holochain/types";
import { bytesToHex } from "../holochain/decode";
import { accountsForPhraseKey, arrive, arrivedFrom, latestActionOf, migrationsToMeOnPrevious, mySuccession, recoveryPlanOf, requestReissue, takeOver, vouchesForMe } from "../holochain/zomes/account";
import { hasPreviousNetwork } from "../holochain/client";
import { bequestsToMe, listIssuers } from "../holochain/zomes/ledger";
import { catalogsOf, importStore, moveStore, previousStores } from "../holochain/zomes/catalog";
import { AccountCode } from "./AccountCode";
import { Button, Field, Input, Skeleton, Spinner, Textarea } from "./ui";
import { adoptPredecessor, keyFingerprint, readPredecessor, type AccountPlace } from "../lib/accountMove";
import { describeError } from "../lib/errors";
import { phraseKey, phraseMessage, readPhrase } from "../lib/recoveryPhrase";
import { POLL } from "../lib/poll";
import { usePolling, useResource } from "../lib/useResource";
import { useSession } from "../store/session";
import { remember, rememberedMethod, type Method } from "../lib/restoring";


export function RestoreAccount({ devAdminUrl, onBack, onDone }: { devAdminUrl: string; onBack: () => void; onDone: () => void }) {
  const { agentPubKey, prepareNewDevice } = useSession();
  const [method, setMethod] = useState<Method | null>(() => (agentPubKey ? rememberedMethod() : null));
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A key that already took an account over (a reload mid-way) goes
  // straight to confirming the details.
  const { data: taken } = useResource(agentPubKey && `succession:${bytesToHex(agentPubKey)}`, mySuccession);
  // A release that carries the previous version of the network offers to
  // bring an account over from it (MIGRATION.md) -- and, after a reload
  // mid-way, picks up where it was.
  const { data: hasPrevious } = useResource(agentPubKey && `has-previous:${bytesToHex(agentPubKey)}`, hasPreviousNetwork);
  const { data: arrived } = useResource(agentPubKey && hasPrevious ? `arrived:${bytesToHex(agentPubKey)}` : null, () => arrivedFrom(agentPubKey!));
  const [predecessor, setPredecessor] = useState<AgentPubKey | null>(null);
  const takenOver = predecessor ?? taken?.predecessor ?? arrived ?? null;
  const place: AccountPlace = method === "previous" || (!!arrived && !taken) ? "previous" : "here";

  async function choose(next: Method) {
    setError(null);
    setPreparing(true);
    try {
      await prepareNewDevice(devAdminUrl);
      remember(next);
      setMethod(next);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPreparing(false);
    }
  }

  if (takenOver && agentPubKey) {
    return (
      <ConfirmDetails
        predecessor={takenOver}
        place={place}
        recovered={place === "previous" ? false : taken ? taken.kind !== "HandOver" : method !== "device"}
        onDone={() => {
          remember(null);
          onDone();
        }}
      />
    );
  }

  const back = method
    ? () => {
        remember(null);
        setMethod(null);
      }
    : onBack;

  return (
    <div>
      <button type="button" onClick={back} className="mb-3 flex items-center gap-1 text-xs font-semibold text-ink-500 hover:text-ink-700">
        <ArrowLeft size={14} /> Back
      </button>
      {!method || !agentPubKey ? (
        <>
          <h2 className="mb-1 text-lg font-bold">Bring your account here</h2>
          <p className="mb-4 text-sm text-ink-500">Your balance, ratings and history come with it.</p>
          <div className="flex flex-col gap-2">
            {hasPrevious && (
              <MethodCard icon={<History size={18} />} title="From the previous version of Relay" blurb="Move your account to this new version." onClick={() => choose("previous")} disabled={preparing} />
            )}
            <MethodCard icon={<Smartphone size={18} />} title="From my other device" blurb="It still works: scan a code with it." onClick={() => choose("device")} disabled={preparing} />
            <MethodCard icon={<KeyRound size={18} />} title="With my recovery phrase" blurb="The twelve words you wrote down." onClick={() => choose("phrase")} disabled={preparing} />
            <MethodCard icon={<HeartHandshake size={18} />} title="With my guardians" blurb="People you chose vouch for this device." onClick={() => choose("guardians")} disabled={preparing} />
          </div>
          {preparing && (
            <p className="mt-3 flex items-center justify-center gap-2 text-xs text-ink-500">
              <Spinner className="h-3 w-3" /> Setting up this device…
            </p>
          )}
          {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        </>
      ) : method === "device" ? (
        <FromDevice me={agentPubKey} onTaken={setPredecessor} />
      ) : method === "previous" ? (
        <FromPreviousVersion me={agentPubKey} onTaken={setPredecessor} />
      ) : method === "phrase" ? (
        <FromPhrase me={agentPubKey} onTaken={setPredecessor} />
      ) : (
        <FromGuardians me={agentPubKey} onTaken={setPredecessor} />
      )}
    </div>
  );
}

function MethodCard({ icon, title, blurb, onClick, disabled }: { icon: React.ReactNode; title: string; blurb: string; onClick: () => void; disabled: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="flex items-center gap-3 rounded-xl border-2 border-ink-100 p-3 text-left transition hover:border-ink-200 disabled:opacity-60">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink-100 text-ink-500">{icon}</span>
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-ink-500">{blurb}</span>
      </span>
    </button>
  );
}

/// Waits for the old device to hand the account over, then takes it.
function FromDevice({ me, onTaken }: { me: AgentPubKey; onTaken: (predecessor: AgentPubKey) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const finish = (predecessor: AgentPubKey) => {
    setDone(true);
    onTaken(predecessor);
  };
  usePolling(
    async () => {
      try {
        // Taken over already, on a try whose answer was lost.
        const taken = await mySuccession();
        if (taken) return finish(taken.predecessor);
        const [bequest] = await bequestsToMe();
        if (!bequest) return;
        await takeOver({ predecessor: bequest.from, authority: { HandOver: { bequest: bequest.bequest } } });
        finish(bequest.from);
      } catch (err) {
        setError(describeError(err));
      }
    },
    { pollMs: POLL.waitingDevice, background: true },
    !done,
  );
  return (
    <>
      <h2 className="mb-1 text-lg font-bold">Scan this with your other device</h2>
      <p className="mb-4 text-sm text-ink-500">On it, open Profile → Account &amp; recovery → Move to a new device.</p>
      <AccountCode agent={me} note="Check this fingerprint matches the one your other device shows before you confirm there." />
      <p className="mt-4 flex items-center justify-center gap-2 text-xs text-ink-400">
        <Spinner className="h-3 w-3" /> Waiting for your other device…
      </p>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
    </>
  );
}

/// Waits for the previous version of the app to move the account here, then
/// records the arrival (MIGRATION.md).
function FromPreviousVersion({ me, onTaken }: { me: AgentPubKey; onTaken: (predecessor: AgentPubKey) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  usePolling(
    async () => {
      try {
        const moved = (await migrationsToMeOnPrevious()).find((m) => m.close);
        if (!moved) return;
        const account = await arrive();
        setDone(true);
        onTaken(account);
      } catch (err) {
        setError(describeError(err));
      }
    },
    { pollMs: POLL.waitingDevice, background: true },
    !done,
  );
  return (
    <>
      <h2 className="mb-1 text-lg font-bold">Move from the previous version</h2>
      <p className="mb-4 text-sm text-ink-500">In the previous version of Relay, open Profile → Account &amp; recovery → Move to the new version, and scan this.</p>
      <AccountCode agent={me} note="Check this fingerprint matches the one the previous version shows before you confirm there." />
      <p className="mt-4 flex items-center justify-center gap-2 text-xs text-ink-400">
        <Spinner className="h-3 w-3" /> Waiting for the previous version…
      </p>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
    </>
  );
}

/// The recovery phrase, typed in: finds the account it recovers and signs
/// for this key.
function FromPhrase({ me, onTaken }: { me: AgentPubKey; onTaken: (predecessor: AgentPubKey) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recover() {
    const phrase = readPhrase(text);
    if (!phrase) {
      setError("That isn't a recovery phrase: check you have all twelve words, spelled as you wrote them.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const key = phraseKey(phrase);
      const [account]: PlanView[] = await accountsForPhraseKey(key.publicKey);
      if (!account) throw new Error("No account uses this phrase. Check the words, and that you set it up before losing your device.");
      const head = await whereItStands(account.account);
      await takeOver({ predecessor: account.account, authority: { Phrase: { plan: account.plan, head, signature: key.sign(phraseMessage(account.account, me, head)) } } });
      await askForReissue();
      onTaken(account.account);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className="mb-1 text-lg font-bold">Your recovery phrase</h2>
      <p className="mb-4 text-sm text-ink-500">The twelve words, in order. They stay on this device.</p>
      <Textarea rows={4} autoCapitalize="none" autoComplete="off" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder="word word word …" className="font-mono" />
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <Button className="mt-4 w-full" loading={busy} disabled={!text.trim()} onClick={recover}>
        Recover my account
      </Button>
    </>
  );
}

/// Shows this device's code to guardians, and takes the account over once
/// enough of them have vouched.
function FromGuardians({ me, onTaken }: { me: AgentPubKey; onTaken: (predecessor: AgentPubKey) => void }) {
  const [progress, setProgress] = useState<{ vouched: number; needed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const finish = (predecessor: AgentPubKey) => {
    setDone(true);
    onTaken(predecessor);
  };
  usePolling(
    async () => {
      try {
        const taken = await mySuccession();
        if (taken) return finish(taken.predecessor);
        const vouches = await vouchesForMe();
        const best = await readiest(vouches);
        if (!best) return;
        setProgress({ vouched: best.vouches.length, needed: best.plan.threshold });
        if (best.vouches.length < best.plan.threshold) return;
        const head = await whereItStands(best.plan.account);
        await takeOver({ predecessor: best.plan.account, authority: { Guardians: { plan: best.plan.plan, head, vouches: best.vouches.map((v) => v.vouch) } } });
        await askForReissue();
        finish(best.plan.account);
      } catch (err) {
        setError(describeError(err));
      }
    },
    { pollMs: POLL.waitingDevice, background: true },
    !done,
  );
  return (
    <>
      <h2 className="mb-1 text-lg font-bold">Ask your guardians</h2>
      <p className="mb-4 text-sm text-ink-500">Call or meet them, then have them scan this in Profile → Account &amp; recovery → Help someone recover.</p>
      <AccountCode agent={me} note="Read the fingerprint to them so they can check it." />
      <p className="mt-4 flex items-center justify-center gap-2 text-xs text-ink-400">
        <Spinner className="h-3 w-3" />
        {progress ? `${progress.vouched} of ${progress.needed} guardians have vouched` : "Waiting for your guardians…"}
      </p>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
    </>
  );
}

/// The account with the most vouches under its current plan, and those
/// vouches -- one per guardian.
async function readiest(vouches: VouchView[]): Promise<{ plan: PlanView; vouches: VouchView[] } | null> {
  const accounts = [...new Set(vouches.map((v) => bytesToHex(v.account)))];
  let best: { plan: PlanView; vouches: VouchView[] } | null = null;
  for (const hex of accounts) {
    const account = vouches.find((v) => bytesToHex(v.account) === hex)!.account;
    const plan = await recoveryPlanOf(account);
    if (!plan || plan.threshold === 0) continue;
    const current = vouches.filter((v) => bytesToHex(v.account) === hex && bytesToHex(v.plan) === bytesToHex(plan.plan));
    const oneEach = current.filter((v, i) => current.findIndex((w) => bytesToHex(w.guardian) === bytesToHex(v.guardian)) === i);
    if (!best || oneEach.length > best.vouches.length) best = { plan, vouches: oneEach };
  }
  return best;
}

/// Where an account stands: its latest action the network has seen. Just
/// after it was found (its plan's links arrive first), its history may take
/// a few seconds more to reach this device.
async function whereItStands(account: AgentPubKey): Promise<Uint8Array> {
  for (let attempt = 0; attempt < STANDING_ATTEMPTS; attempt++) {
    const head = await latestActionOf(account);
    if (head) return head;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Your account isn't reachable yet. Check your connection and try again in a moment.");
}

const STANDING_ATTEMPTS = 15;

/// Asks the network's issuers to reissue the recovered balance -- each one
/// asked; only one pays (see the issuer service's recovery.ts).
async function askForReissue() {
  const issuers = await listIssuers().catch(() => []);
  await Promise.allSettled(issuers.map((i) => requestReissue(i.issuer)));
}

/// The account's details, confirmed for this device: the name and phone it
/// had (sealed to the old key, so carried only by a hand-over).
function ConfirmDetails({ predecessor, place, recovered, onDone }: { predecessor: AgentPubKey; place: AccountPlace; recovered: boolean; onDone: () => void }) {
  const reconnect = useSession((s) => s.reconnect);
  const { data: known } = useResource(`predecessor:${place}:${bytesToHex(predecessor)}`, () => readPredecessor(predecessor, place));
  const { data: issuers } = useResource("issuers", listIssuers);
  const [name, setName] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!known) return <Skeleton className="h-48 w-full" />;
  const shownName = name ?? known.name;
  const shownPhone = phone ?? known.phone;
  const wait = issuers?.find((i) => i.profile)?.profile?.recovery_wait_days;

  async function finish() {
    if (!known) return;
    setBusy(true);
    setError(null);
    try {
      // Their stores first -- safe to repeat -- then their profile, so a
      // failure here can simply be tried again.
      if (place === "previous") {
        for (const store of await previousStores()) await importStore(store.original_action);
      } else {
        for (const store of await catalogsOf(predecessor)) await moveStore(store.original_action);
      }
      await adoptPredecessor(known, shownName, shownPhone);
      await reconnect();
      onDone();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className="mb-1 text-lg font-bold">Your account is here</h2>
      <p className="mb-4 text-sm text-ink-500">
        From the account {keyFingerprint(predecessor)}. {recovered ? "Check your details: the old device kept some of them private." : "Your details came with it."}
      </p>
      <Field label="Your name" className="mb-3">
        <Input value={shownName} onChange={(e) => setName(e.target.value)} placeholder="Alex Rivera" />
      </Field>
      <Field label="Phone (optional)" className="mb-3">
        <Input value={shownPhone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      {recovered && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Your balance is reissued to this device by the network's issuer once your old device has gone unused for {wait ? `${wait} day${wait === 1 ? "" : "s"}` : "a while"} -- so nobody holding it can spend it twice.

        </p>
      )}
      {place === "previous" && (
        <p className="mb-3 rounded-lg bg-relay-50 px-3 py-2 text-xs text-relay-800">Your balance is carried over by the network's issuer within a few minutes, and your ratings and history come with you.</p>
      )}
      {known.profile?.roles.includes("Merchant") && (
        <p className="mb-3 text-xs text-ink-500">Your stores come with you, with their menus and ratings. List them again from your store screen to take orders.</p>
      )}
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <Button className="w-full" loading={busy} disabled={!shownName.trim()} onClick={finish}>
        Enter Relay
      </Button>
    </>
  );
}
