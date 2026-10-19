// An arbiter's docket (one of the network's `arbiters`): each appeal of a
// store's settlement, with both sides' evidence -- sealed to the arbiter
// alone -- and the ruling. An award is paid from the store's next
// cash-out.
import { useState } from "react";
import { Gavel } from "lucide-react";
import type { AppealView } from "../holochain/types";
import { getMyDocket, ruleOnAppeal } from "../holochain/zomes/dispatch";
import { bytesToHex } from "../holochain/decode";
import { Button, Card, Input, Textarea } from "../components/ui";
import { describeError } from "../lib/errors";
import { currencySymbol, formatCents, fromMinorUnits, timeAgo, toMinorUnits } from "../lib/format";
import { POLL } from "../lib/poll";
import { useResource } from "../lib/useResource";
import { MAX_NOTE_CHARS } from "../holochain/types";

export default function ArbitratePage() {
  const { data: docket, reload } = useResource("docket", getMyDocket, { pollMs: POLL.slow });
  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <h1 className="mb-1 flex items-center gap-2 text-xl font-black text-ink-900 dark:text-ink-50">
        <Gavel size={20} /> Appeals
      </h1>
      <p className="mb-5 text-sm text-ink-500">Customers appealing a store's decision. Weigh both sides; an award comes from the store's next cash-out.</p>
      {docket?.length === 0 && <p className="text-sm text-ink-400">Nothing before you.</p>}
      <div className="flex flex-col gap-4">
        {docket?.map((appeal) => <Case key={bytesToHex(appeal.appeal)} appeal={appeal} onRuled={reload} />)}
      </div>
    </div>
  );
}

function Side({ who, note, photo }: { who: string; note: string | undefined; photo: string | undefined }) {
  return (
    <div className="rounded-xl bg-ink-50 p-3 dark:bg-ink-800">
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">{who}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-ink-800 dark:text-ink-100">{note ?? "Nothing yet."}</p>
      {photo && <img src={photo} alt="" className="mt-2 max-h-48 rounded-lg" />}
    </div>
  );
}

function Case({ appeal, onRuled }: { appeal: AppealView; onRuled: () => Promise<void> }) {
  const [award, setAward] = useState(fromMinorUnits(appeal.amount));
  const [reasons, setReasons] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rule(amount: number) {
    setBusy(true);
    setError(null);
    try {
      await ruleOnAppeal({ appeal: appeal.appeal, award: amount, reasons: reasons.trim() });
      await onRuled();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between">
        <p className="font-bold text-ink-900 dark:text-ink-50">Asks {formatCents(appeal.amount)}</p>
        <p className="text-xs text-ink-400">{timeAgo(appeal.filed_at)}</p>
      </div>
      <p className="text-xs text-ink-500">
        Order of {formatCents(appeal.order_total)}; the store refunded {formatCents(appeal.refund)}.
      </p>
      <Side who="Customer" note={appeal.customer_evidence?.note} photo={appeal.customer_evidence?.photo_data_uri} />
      <Side who="Store" note={appeal.answered ? appeal.store_evidence?.note : undefined} photo={appeal.store_evidence?.photo_data_uri} />
      {appeal.ruling ? (
        <p className="text-sm font-semibold text-ink-700 dark:text-ink-200">
          Ruled: {appeal.ruling.award > 0 ? `${formatCents(appeal.ruling.award)} awarded` : "dismissed"}
        </p>
      ) : (
        <>
          <Input type="number" min={0} step={0.5} value={award} onChange={(e) => setAward(Number(e.target.value))} prefix={currencySymbol()} />
          <Textarea maxLength={MAX_NOTE_CHARS} rows={2} value={reasons} onChange={(e) => setReasons(e.target.value)} placeholder="Why -- both sides see this" />
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex gap-2">
            <Button className="flex-1" loading={busy} disabled={!reasons.trim() || award <= 0 || toMinorUnits(award) > appeal.amount} onClick={() => rule(toMinorUnits(award))}>
              Award
            </Button>
            <Button className="flex-1" variant="secondary" loading={busy} disabled={!reasons.trim()} onClick={() => rule(0)}>
              Dismiss
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
