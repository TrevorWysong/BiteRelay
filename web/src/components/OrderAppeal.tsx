// An appeal of the store's settlement (the dispatch `appeals` module): once
// the store has settled, its customer can take what it kept to the
// network's arbiter, the store gives its side, and the arbiter's award is
// paid from the store's next cash-out. Shown on both sides of a settled
// order, on networks with arbiters.
import { useState } from "react";
import { Gavel } from "lucide-react";
import { answerAppeal, fileAppeal, getAppealForOrder } from "../holochain/zomes/dispatch";
import { bytesToHex } from "../holochain/decode";
import { MAX_NOTE_CHARS, type AppealView } from "../holochain/types";
import { describeError } from "../lib/ui/errors";
import { formatCents, fromMinorUnits, toMinorUnits, currencySymbol } from "../lib/ui/format";
import { POLL } from "../lib/network/poll";
import { useResource } from "../lib/hooks/useResource";
import { useTerms } from "../store/network";
import { Button, Input, Textarea } from "./ui";
import { PhotoInput } from "./PhotoInput";
import { Sheet } from "./Sheet";
import { useT } from "../i18n";

export function OrderAppeal({ orderRef, role, kept }: { orderRef: Uint8Array; role: "customer" | "store"; kept: number }) {
  const terms = useTerms();
  const t = useT();
  const { data: appeal, reload } = useResource(terms.appeals ? `appeal:${bytesToHex(orderRef)}` : null, () => getAppealForOrder(orderRef), { pollMs: POLL.slow });
  const [open, setOpen] = useState(false);
  if (!terms.appeals || appeal === undefined) return null;
  if (!appeal && (role === "store" || kept === 0)) return null;
  const days = Math.round(terms.appeal_window_secs / 86_400);

  return (
    <div className="border-t border-ink-100 p-4 dark:border-ink-800">
      {appeal ? (
        <AppealStatus appeal={appeal} role={role} onAnswer={() => setOpen(true)} />
      ) : (
        <>
          <p className="mb-2 text-xs text-ink-500">{t("appeal.window", { days })}</p>
          <Button variant="ghost" className="w-full" onClick={() => setOpen(true)}>
            <Gavel size={15} /> {t("appeal.cta")}
          </Button>
        </>
      )}
      {open && (
        <EvidenceSheet
          title={appeal ? t("appeal.yourSide") : t("appeal.toArbiter")}
          subtitle={appeal ? t("appeal.onlyArbiter") : t("appeal.howItWorks")}
          maxAmount={appeal ? null : kept}
          onClose={() => setOpen(false)}
          onSend={async ({ amount, note, photo }) => {
            if (appeal) await answerAppeal({ appeal: appeal.appeal, note, photo_data_uri: photo });
            else await fileAppeal({ order: orderRef, amount, note, photo_data_uri: photo });
            setOpen(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function AppealStatus({ appeal, role, onAnswer }: { appeal: AppealView; role: "customer" | "store"; onAnswer: () => void }) {
  const ruling = appeal.ruling;
  const t = useT();
  return (
    <div className="flex items-start gap-3">
      <Gavel size={18} className="mt-0.5 shrink-0 text-handshake-500" />
      <div className="min-w-0 flex-1 text-sm">
        {ruling ? (
          <>
            <p className="font-semibold text-ink-900 dark:text-ink-50">{ruling.award > 0 ? t("appeal.awarded", { amount: formatCents(ruling.award) }) : t("appeal.dismissed")}</p>
            {ruling.reasons && <p className="mt-0.5 text-xs text-ink-500">“{ruling.reasons}”</p>}
            {ruling.award > 0 && (
              <p className="mt-1 text-xs text-ink-400">{role === "customer" ? t("appeal.paidToYou") : t("appeal.paidByYou")}</p>
            )}
          </>
        ) : (
          <>
            <p className="font-semibold text-ink-900 dark:text-ink-50">{t(role === "customer" ? "appeal.appealedFor" : "appeal.customerAppealedFor", { amount: formatCents(appeal.amount) })}</p>
            <p className="mt-0.5 text-xs text-ink-500">{t(appeal.answered ? "appeal.bothIn" : role === "store" ? "appeal.giveSide" : "appeal.waitingStore")}</p>
            {role === "store" && !appeal.answered && (
              <Button className="mt-2 py-2 text-xs" onClick={onAnswer}>
                {t("appeal.giveSideButton")}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/// A note and a photo -- and, for an appeal, how much to ask for.
export function EvidenceSheet({
  title,
  subtitle,
  maxAmount,
  onClose,
  onSend,
}: {
  title: string;
  subtitle: string;
  maxAmount: number | null;
  onClose: () => void;
  onSend: (input: { amount: number; note: string; photo: string }) => Promise<void>;
}) {
  const t = useT();
  const [amount, setAmount] = useState(maxAmount === null ? 0 : fromMinorUnits(maxAmount));
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await onSend({ amount: toMinorUnits(amount), note: note.trim(), photo });
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      footer={
        <>
          {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          <Button className="w-full" loading={busy} disabled={!note.trim() || (maxAmount !== null && (amount <= 0 || toMinorUnits(amount) > maxAmount))} onClick={send}>
            {t("appeal.send")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {maxAmount !== null && (
          <div>
            <p className="mb-1 text-xs font-semibold text-ink-500">{t("appeal.askFor", { amount: formatCents(maxAmount) })}</p>
            <Input type="number" min={0} step={0.5} value={amount} onChange={(e) => setAmount(Number(e.target.value))} prefix={currencySymbol()} />
          </div>
        )}
        <Textarea maxLength={MAX_NOTE_CHARS} rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("appeal.whatHappened")} />
        <PhotoInput value={photo} onChange={setPhoto} />
      </div>
    </Sheet>
  );
}
