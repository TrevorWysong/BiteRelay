// An arbiter's docket (one of the network's `arbiters`): each appeal of a
// store's settlement, with both sides' evidence -- sealed to the arbiter
// alone -- and the ruling. An award is paid from the store's next
// cash-out.
import { useState } from "react";
import { Gavel } from "lucide-react";
import type { AppealsPage, AppealView } from "../holochain/types";
import { getMyDocket, ruleOnAppeal } from "../holochain/zomes/dispatch";
import { bytesToHex } from "../holochain/decode";
import { Button, Card, Input, Textarea } from "../components/ui";
import { describeError } from "../lib/errors";
import { currencySymbol, formatCents, fromMinorUnits, timeAgo, toMinorUnits } from "../lib/format";
import { POLL } from "../lib/poll";
import { useResource } from "../lib/useResource";
import { MAX_NOTE_CHARS } from "../holochain/types";
import { useT } from "../i18n";

export default function ArbitratePage() {
  const t = useT();
  const { data: first, reload } = useResource("docket", () => getMyDocket(), { pollMs: POLL.slow });
  // Pages past the first, loaded on request; the first keeps refreshing.
  const [older, setOlder] = useState<AppealsPage | null>(null);
  const [loading, setLoading] = useState(false);
  const cursor = older ? older.next_before : (first?.next_before ?? null);
  const seen = new Set((first?.appeals ?? []).map((a) => bytesToHex(a.appeal)));
  const docket = first && [...first.appeals, ...(older?.appeals ?? []).filter((a) => !seen.has(bytesToHex(a.appeal)))];

  async function loadOlder() {
    if (cursor === null) return;
    setLoading(true);
    try {
      const page = await getMyDocket(cursor);
      setOlder((prev) => ({ appeals: [...(prev?.appeals ?? []), ...page.appeals], next_before: page.next_before }));
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <h1 className="mb-1 flex items-center gap-2 text-xl font-black text-ink-900 dark:text-ink-50">
        <Gavel size={20} /> {t("account.appeals")}
      </h1>
      <p className="mb-5 text-sm text-ink-500">{t("arbitrate.intro")}</p>
      {docket?.length === 0 && <p className="text-sm text-ink-400">{t("arbitrate.empty")}</p>}
      <div className="flex flex-col gap-4">
        {docket?.map((appeal) => <Case key={bytesToHex(appeal.appeal)} appeal={appeal} onRuled={reload} />)}
      </div>
      {cursor !== null && (
        <Button variant="ghost" loading={loading} onClick={loadOlder} className="mt-4 w-full py-2 text-xs">
          {t("common.loadMore")}
        </Button>
      )}
    </div>
  );
}

function Side({ who, note, photo }: { who: string; note: string | undefined; photo: string | undefined }) {
  const t = useT();
  return (
    <div className="rounded-xl bg-ink-50 p-3 dark:bg-ink-800">
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-400">{who}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-ink-800 dark:text-ink-100">{note ?? t("arbitrate.nothingYet")}</p>
      {photo && <img src={photo} alt="" className="mt-2 max-h-48 rounded-lg" />}
    </div>
  );
}

function Case({ appeal, onRuled }: { appeal: AppealView; onRuled: () => Promise<void> }) {
  const t = useT();
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
        <p className="font-bold text-ink-900 dark:text-ink-50">{t("arbitrate.asks", { amount: formatCents(appeal.amount) })}</p>
        <p className="text-xs text-ink-400">{timeAgo(appeal.filed_at)}</p>
      </div>
      <p className="text-xs text-ink-500">
        {t("arbitrate.orderOf", { total: formatCents(appeal.order_total), refund: formatCents(appeal.refund) })}
      </p>
      <Side who={t("role.Requester")} note={appeal.customer_evidence?.note} photo={appeal.customer_evidence?.photo_data_uri} />
      <Side who={t("role.Merchant")} note={appeal.answered ? appeal.store_evidence?.note : undefined} photo={appeal.store_evidence?.photo_data_uri} />
      {appeal.ruling ? (
        <p className="text-sm font-semibold text-ink-700 dark:text-ink-200">
          {appeal.ruling.award > 0 ? t("arbitrate.ruledAward", { amount: formatCents(appeal.ruling.award) }) : t("arbitrate.ruledDismissed")}
        </p>
      ) : (
        <>
          <Input type="number" min={0} step={0.5} value={award} onChange={(e) => setAward(Number(e.target.value))} prefix={currencySymbol()} />
          <Textarea maxLength={MAX_NOTE_CHARS} rows={2} value={reasons} onChange={(e) => setReasons(e.target.value)} placeholder={t("arbitrate.why")} />
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex gap-2">
            <Button className="flex-1" loading={busy} disabled={!reasons.trim() || award <= 0 || toMinorUnits(award) > appeal.amount} onClick={() => rule(toMinorUnits(award))}>
              {t("arbitrate.award")}
            </Button>
            <Button className="flex-1" variant="secondary" loading={busy} disabled={!reasons.trim()} onClick={() => rule(0)}>
              {t("arbitrate.dismiss")}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
