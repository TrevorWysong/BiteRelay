// A verifier's screen (one of the network's `verifiers`): scan a driver's
// code once their documents are checked, choose what was checked, and
// vouch for them -- or withdraw a verification.
import { useState } from "react";
import { BadgeCheck } from "lucide-react";
import type { AgentPubKey, VerificationCheck } from "../holochain/types";
import { driverVerification, getVerificationTerms, revokeVerification, verifyDriver } from "../holochain/zomes/dispatch";
import { AccountCodeReader } from "../components/AccountCode";
import { Button, Card, Checkbox, Field, Input } from "../components/ui";
import { keyFingerprint } from "../lib/accountMove";
import { describeError } from "../lib/errors";
import { formatDate } from "../lib/format";
import { useResource } from "../lib/useResource";
import { ALL_CHECKS, CHECK_LABELS } from "../lib/verification";
import { bytesToHex } from "../holochain/decode";
import { useSession } from "../store/session";

export default function VerifyPage() {
  const me = useSession((s) => s.agentPubKey);
  const { data: terms } = useResource("verification-terms", getVerificationTerms);
  const [driver, setDriver] = useState<AgentPubKey | null>(null);
  if (!terms || !me) return null;
  if (!terms.verifiers.some((v) => bytesToHex(v) === bytesToHex(me))) {
    return <p className="p-6 text-sm text-ink-500">Only the network's verifiers verify drivers.</p>;
  }
  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <h1 className="mb-1 text-xl font-black text-ink-900 dark:text-ink-50">Verify a driver</h1>
      <p className="mb-5 text-sm text-ink-500">Check their documents first, then scan the code on their Drive screen.</p>
      {driver ? <DriverForm key={bytesToHex(driver)} driver={driver} onDone={() => setDriver(null)} /> : <AccountCodeReader prompt="Point at the driver's code" onKey={setDriver} />}
    </div>
  );
}

function DriverForm({ driver, onDone }: { driver: AgentPubKey; onDone: () => void }) {
  const { data: current, reload } = useResource(`verification:${bytesToHex(driver)}`, () => driverVerification(driver));
  const [checks, setChecks] = useState<VerificationCheck[]>(["Identity", "DrivingLicence", "Insurance"]);
  const [days, setDays] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      setDone(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="text-center">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">Driver</p>
        <p className="font-mono text-lg font-black tracking-widest text-ink-900 dark:text-ink-50">{keyFingerprint(driver)}</p>
        <p className="text-xs text-ink-400">Compare it with the one on their screen.</p>
      </div>
      {current && (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-200">
          <BadgeCheck size={16} /> Verified until {formatDate(current.expires_at)}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {ALL_CHECKS.map((check) => (
          <label key={check} className="flex items-center gap-2 text-sm">
            <Checkbox checked={checks.includes(check)} onChange={(e) => setChecks(e.target.checked ? [...checks, check] : checks.filter((c) => c !== check))} />
            {CHECK_LABELS[check]}
          </label>
        ))}
      </div>
      <Field label="Days it lasts (blank for the network's longest)">
        <Input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value === "" ? "" : Math.max(1, Number(e.target.value)))} />
      </Field>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {done && <p className="text-xs text-emerald-600">Done.</p>}
      <Button loading={busy} disabled={checks.length === 0} onClick={() => run(() => verifyDriver(driver, checks, days === "" ? null : days))}>
        {current ? "Renew verification" : "Verify driver"}
      </Button>
      {current && (
        <Button variant="secondary" loading={busy} onClick={() => run(() => revokeVerification(current.action))}>
          Withdraw verification
        </Button>
      )}
      <button className="text-xs font-semibold text-relay-600" onClick={onDone}>
        Another driver
      </button>
    </Card>
  );
}
