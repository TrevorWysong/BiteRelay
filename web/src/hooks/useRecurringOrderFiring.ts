// Recurring orders have no p2p cron (see `RecurringOrderTemplate`'s own
// Rust doc comment) -- this is the client-driven firing loop that makes
// them actually work, mounted once at the app shell level (not any one
// screen) so it keeps running regardless of which tab is open. Best-effort
// by design: a failed fire (a stale promo code, a since-closed merchant)
// still advances `next_run_at`, so one bad occurrence can't wedge every
// future one behind it.
import { useEffect } from "react";
import { listMyRecurringTemplates, advanceRecurringTemplate, requestDelivery } from "../holochain/zomes/dispatch";
import { listMenuItems } from "../holochain/zomes/catalog";
import { decodeEntry, actionHash, bytesEqual, bytesToHex } from "../holochain/decode";
import { nextOccurrence, toMicros } from "../lib/recurrence";
import type { MenuItem, RecurringOrderTemplate } from "../holochain/types";

const CHECK_INTERVAL_MS = 60_000;

export function useRecurringOrderFiring() {
  useEffect(() => {
    let cancelled = false;

    async function fireDueTemplates() {
      const now = Date.now() * 1000;
      let records;
      try {
        records = await listMyRecurringTemplates();
      } catch {
        return;
      }
      for (const record of records) {
        if (cancelled) return;
        const template = decodeEntry<RecurringOrderTemplate>(record);
        if (!template.active || template.next_run_at > now) continue;
        const originalAction = actionHash(record);

        try {
          // Best-effort re-resolution against the current menu, same
          // reasoning as Orders.tsx's reorder() -- an item removed or made
          // unavailable since this template was saved just gets dropped
          // rather than failing the whole fire. order_total is recomputed
          // fresh from current prices for the same reason; any promo
          // discount isn't re-applied here, the same honestly-scoped
          // limitation reorder() already has.
          const page = await listMenuItems(template.catalog_ref);
          const availableItems = page.items.filter((r) => decodeEntry<MenuItem>(r).available);
          const itemRefs = template.item_refs.filter((ref) => availableItems.some((r) => bytesEqual(actionHash(r), ref)));
          if (itemRefs.length > 0) {
            const orderTotal = itemRefs.reduce((sum, ref) => {
              const item = availableItems.find((r) => bytesEqual(actionHash(r), ref));
              return sum + (item ? decodeEntry<MenuItem>(item).price_cents : 0);
            }, 0);
            await requestDelivery({
              merchant: template.merchant,
              catalog_ref: template.catalog_ref,
              item_refs: itemRefs,
              order_total: orderTotal,
              dropoff: template.dropoff,
              max_delivery_fee: template.max_delivery_fee,
              special_instructions: template.special_instructions,
              tip_cents: template.tip_cents,
              dropoff_preference: template.dropoff_preference,
              promo_code_ref: template.promo_code_ref,
            });
          }
        } catch {
          // Best-effort -- see the module doc comment. Fall through to
          // advancing next_run_at regardless, so this doesn't retry every
          // poll tick forever.
        }

        const next = toMicros(nextOccurrence(template.recurrence, new Date()));
        await advanceRecurringTemplate(originalAction, next).catch(() => {});
      }
    }

    fireDueTemplates();
    const interval = setInterval(fireDueTemplates, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
}
