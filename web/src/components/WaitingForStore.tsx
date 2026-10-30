import { Store } from "lucide-react";
import { Button, Card } from "./ui";
import { ResponseCountdown } from "./ResponseCountdown";
import { responseDeadlineMs } from "../lib/orders/storeAnswers";
import { useTerms } from "../store/network";
import { useT } from "../i18n";

/// An order waiting on its store to accept it: how long the store has, and
/// a way to withdraw it meanwhile. `writtenAt` is when the order reached
/// the store (its latest version's timestamp); `now`, when it was read.
export function WaitingForStore({ writtenAt, now, cancelling, onCancel }: { writtenAt: number; now: number; cancelling: boolean; onCancel: () => void }) {
  const windowSecs = useTerms().store_response_secs;
  const t = useT();
  return (
    <Card className="mt-3 p-4">
      <div className="flex items-center gap-3">
        <Store size={20} className="shrink-0 text-handshake-600" />
        <p className="text-sm text-ink-700 dark:text-ink-200">{t("waiting.store")}</p>
      </div>
      <ResponseCountdown deadlineMs={responseDeadlineMs(writtenAt, windowSecs)} windowSecs={windowSecs} now={now} label="waiting.until" />
      <Button variant="ghost" className="mt-3 w-full py-2 text-xs" loading={cancelling} onClick={onCancel}>
        {t("order.cancel")}
      </Button>
    </Card>
  );
}
