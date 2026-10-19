// Appeals of the store's decisions waiting for its side -- on any order,
// however old -- at the top of its orders.
import { useState } from "react";
import { Gavel } from "lucide-react";
import { answerAppeal, getAppealsAgainstMe } from "../holochain/zomes/dispatch";
import { bytesToHex } from "../holochain/decode";
import type { AppealView } from "../holochain/types";
import { formatCents } from "../lib/format";
import { POLL } from "../lib/poll";
import { useResource } from "../lib/useResource";
import { useTerms } from "../store/network";
import { EvidenceSheet } from "./OrderAppeal";
import { Button, Card } from "./ui";
import { useT } from "../i18n";

export function StoreAppeals() {
  const appeals = useTerms().appeals;
  const t = useT();
  const { data, reload } = useResource(appeals ? "appeals-against-me" : null, getAppealsAgainstMe, { pollMs: POLL.slow });
  const [answering, setAnswering] = useState<AppealView | null>(null);
  const waiting = (data ?? []).filter((a) => !a.answered && !a.ruling);
  if (waiting.length === 0) return null;
  return (
    <Card className="mb-4 p-4">
      <p className="flex items-center gap-2 font-bold text-ink-900 dark:text-ink-50">
        <Gavel size={16} /> {t("appeal.storeWaiting", { count: waiting.length })}
      </p>
      <p className="mt-0.5 text-xs text-ink-500">The network's arbiter decides; an award comes out of your next cash-out. Give your side.</p>
      <ul className="mt-3 flex flex-col gap-2">
        {waiting.map((appeal) => (
          <li key={bytesToHex(appeal.appeal)} className="flex items-center justify-between gap-3 text-sm">
            <span>
              Asks {formatCents(appeal.amount)} of a {formatCents(appeal.order_total)} order
            </span>
            <Button className="py-1.5 text-xs" onClick={() => setAnswering(appeal)}>
              Give your side
            </Button>
          </li>
        ))}
      </ul>
      {answering && (
        <EvidenceSheet
          title="Your side"
          subtitle="Only the arbiter sees what you send."
          maxAmount={null}
          onClose={() => setAnswering(null)}
          onSend={async ({ note, photo }) => {
            await answerAppeal({ appeal: answering.appeal, note, photo_data_uri: photo });
            setAnswering(null);
            await reload();
          }}
        />
      )}
    </Card>
  );
}
