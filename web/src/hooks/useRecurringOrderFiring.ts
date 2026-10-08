// Recurring orders have no p2p cron (see `RecurringOrderTemplate`'s Rust
// doc comment) -- this is the client-driven loop that fires them, mounted
// once in the app shell so it runs whatever screen is open. Best-effort by
// design: a failed fire (a stale promo code, a since-closed store) still
// advances `next_run_at`, so one bad occurrence can't wedge every later one.
import { useRef } from "react";
import { listMyRecurringTemplates, advanceRecurringTemplate, requestDelivery } from "../holochain/zomes/dispatch";
import { decodeEntry, bytesEqual } from "../holochain/decode";
import { nextOccurrence, toMicros } from "../lib/recurrence";
import { fetchMenu } from "../lib/menu";
import { usePolling } from "../lib/useResource";
import type { RecurringOrderTemplate } from "../holochain/types";

const CHECK_INTERVAL_MS = 60_000;

export function useRecurringOrderFiring() {
  // A tick that started while the last was still firing would see the same
  // templates as due and fire them twice; skip it instead.
  const running = useRef(false);
  usePolling(
    async () => {
      if (running.current) return;
      running.current = true;
      try {
        await fireDueTemplates();
      } finally {
        running.current = false;
      }
    },
    { pollMs: CHECK_INTERVAL_MS },
  );
}

async function fireDueTemplates() {
  const now = Date.now() * 1000;
  const views = await listMyRecurringTemplates().catch(() => []);
  for (const view of views) {
    const template = decodeEntry<RecurringOrderTemplate>(view.record);
    if (!template.active || template.next_run_at > now) continue;
    try {
      await fire(template);
    } catch {
      // Best-effort -- see the module doc comment. Advance regardless, so a
      // failing template isn't retried every tick forever.
    }
    const next = toMicros(nextOccurrence(template.recurrence, new Date()));
    await advanceRecurringTemplate(view.original_action, next).catch(() => {});
  }
}

/// Re-resolves the template against the store's *current* menu, like
/// reorder: an item since removed or made unavailable is dropped rather
/// than failing the whole order, and the total is recomputed from current
/// prices. (A promo discount isn't re-applied -- the same limit reorder has.)
async function fire(template: RecurringOrderTemplate) {
  const available = (await fetchMenu(template.catalog_ref)).filter((row) => row.item.available);
  const lines = template.item_refs.flatMap((ref) => available.filter((row) => bytesEqual(row.hash, ref)).slice(0, 1));
  if (lines.length === 0) return;
  await requestDelivery({
    merchant: template.merchant,
    catalog_ref: template.catalog_ref,
    item_refs: lines.map((row) => row.hash),
    order_total: lines.reduce((sum, row) => sum + row.item.price_cents, 0),
    dropoff: template.dropoff,
    max_delivery_fee: template.max_delivery_fee,
    special_instructions: template.special_instructions,
    tip_cents: template.tip_cents,
    dropoff_preference: template.dropoff_preference,
    promo_code_ref: template.promo_code_ref,
  });
}
