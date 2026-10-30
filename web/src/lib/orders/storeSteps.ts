// What a store's app does for it while it's open: the steps its orders call
// for once a deadline passes that cost someone else if claimed early --
// moving on a late driver who's committed, recording a customer collecting
// from a late driver, ending an order no driver came for. Each needs proof
// of the time from the network's time source, which the store's conductor
// can't reach; so its app fetches a round and takes them. (The conductor
// takes every step that's the store's word on its own.)
import { getStoreStepsDue, takeStoreStep } from "../../holochain/zomes/dispatch";
import { POLL, isOrderSignal } from "../network/poll";
import { currentBeacon } from "../network/timeSource";
import { usePolling } from "../hooks/useResource";

export function useStoreSteps(enabled: boolean) {
  usePolling(
    async () => {
      const due = await getStoreStepsDue().catch(() => []);
      if (due.length === 0) return;
      const beacon = await currentBeacon().catch(() => null);
      if (!beacon) return;
      // One at a time, each on its own: one that can't go yet (still
      // gossiping) never holds up the rest; the next tick retries it.
      for (const { step, order } of due) {
        await takeStoreStep(step, order, beacon).catch(() => null);
      }
    },
    { pollMs: POLL.unsignalled, refreshOn: isOrderSignal, background: true },
    enabled,
  );
}
