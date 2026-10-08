import { Store } from "lucide-react";
import { Button, Card } from "./ui";
import { ResponseCountdown } from "./ResponseCountdown";
import { responseDeadlineMs } from "../lib/storeAnswers";
import { useStoreResponseSecs } from "../lib/useStoreResponseSecs";

/// An order waiting on its store to accept it: how long the store has, and
/// a way to withdraw it meanwhile. `writtenAt` is when the order reached
/// the store (its latest version's timestamp); `now`, when it was read.
export function WaitingForStore({ writtenAt, now, cancelling, onCancel }: { writtenAt: number; now: number; cancelling: boolean; onCancel: () => void }) {
  const windowSecs = useStoreResponseSecs();
  return (
    <Card className="mt-3 p-4">
      <div className="flex items-center gap-3">
        <Store size={20} className="shrink-0 text-relay-600" />
        <p className="text-sm text-ink-700 dark:text-ink-200">Waiting for the store to accept your order. If it doesn't in time, the order is cancelled and you aren't charged.</p>
      </div>
      {windowSecs !== undefined && <ResponseCountdown deadlineMs={responseDeadlineMs(writtenAt, windowSecs)} windowSecs={windowSecs} now={now} label="The store has until" />}
      <Button variant="ghost" className="mt-3 w-full py-2 text-xs" loading={cancelling} onClick={onCancel}>
        Cancel order
      </Button>
    </Card>
  );
}
