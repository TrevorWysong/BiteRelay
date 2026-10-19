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
import { describeError } from "../lib/errors";
import { formatCents, fromMinorUnits, toMinorUnits, currencySymbol } from "../lib/format";
import { POLL } from "../lib/poll";
import { useResource } from "../lib/useResource";
import { useTerms } from "../store/network";
import { Button, Input, Textarea } from "./ui";
import { PhotoInput } from "./PhotoInput";
import { Sheet } from "./Sheet";

export function OrderAppeal({ orderRef, role, kept }: { orderRef: Uint8Array; role: "customer" | "store"; kept: number }) {
  const terms = useTerms();
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
          <p className="mb-2 text-xs text-ink-500">Disagree with the store? You can appeal to the network's arbiter within {days} days of its decision.</p>
          <Button variant="ghost" className="w-full" onClick={() => setOpen(true)}>
            <Gavel size={15} /> Appeal the store's decision
          </Button>
        </>
      )}
      {open && (
        <EvidenceSheet
          title={appeal ? "Your side" : "Appeal to the arbiter"}
          subtitle={appeal ? "Only the arbiter sees what you send." : "The arbiter sees this and the store's side, then decides. Their award comes from the store."}
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
  return (
    <div className="flex items-start gap-3">
      <Gavel size={18} className="mt-0.5 shrink-0 text-relay-500" />
      <div className="min-w-0 flex-1 text-sm">
        {ruling ? (
          <>
            <p className="font-semibold text-ink-900 dark:text-ink-50">{ruling.award > 0 ? `The arbiter awarded ${formatCents(ruling.award)}` : "The arbiter dismissed the appeal"}</p>
            {ruling.reasons && <p className="mt-0.5 text-xs text-ink-500">“{ruling.reasons}”</p>}
            {ruling.award > 0 && (
              <p className="mt-1 text-xs text-ink-400">{role === "customer" ? "It's paid to your balance from the store's next cash-out." : "It comes out of your next cash-out."}</p>
            )}
          </>
        ) : (
          <>
            <p className="font-semibold text-ink-900 dark:text-ink-50">{role === "customer" ? `Appealed for ${formatCents(appeal.amount)}` : `The customer appealed for ${formatCents(appeal.amount)}`}</p>
            <p className="mt-0.5 text-xs text-ink-500">{appeal.answered ? "Both sides are in. The arbiter will decide." : role === "store" ? "Give the arbiter your side." : "Waiting for the store's side, then the arbiter decides."}</p>
            {role === "store" && !appeal.answered && (
              <Button className="mt-2 py-2 text-xs" onClick={onAnswer}>
                Give your side
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
            Send
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {maxAmount !== null && (
          <div>
            <p className="mb-1 text-xs font-semibold text-ink-500">What you ask for (up to {formatCents(maxAmount)})</p>
            <Input type="number" min={0} step={0.5} value={amount} onChange={(e) => setAmount(Number(e.target.value))} prefix={currencySymbol()} />
          </div>
        )}
        <Textarea maxLength={MAX_NOTE_CHARS} rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened" />
        <PhotoInput value={photo} onChange={setPhoto} />
      </div>
    </Sheet>
  );
}
