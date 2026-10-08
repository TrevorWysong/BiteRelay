// Recurring orders have no p2p cron (see `RecurringOrderTemplate`'s Rust
// doc comment) -- this is the client-driven loop that fires them, mounted
// once in the app shell so it runs whatever screen is open. Best-effort by
// design: a failed fire (a stale promo code, a since-closed store) still
// advances `next_run_at`, so one bad occurrence can't wedge every later one.
import { useRef } from "react";
import { listMyRecurringTemplates, advanceRecurringTemplate, requestDelivery, countMyCompletedOrders } from "../holochain/zomes/dispatch";
import { getPromoCode } from "../holochain/zomes/catalog";
import { evaluatePromo } from "../lib/promotions";
import type { CartLine } from "../store/cart";
import { decodeEntry, bytesEqual, bytesToHex } from "../holochain/decode";
import { nextOccurrence, toMicros } from "../lib/recurrence";
import { fetchMenu } from "../lib/menu";
import { usePolling } from "../lib/useResource";
import type { PromoCode, RecurringOrderTemplate } from "../holochain/types";

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
/// than failing the whole order. The total is priced the way the zome will
/// check it -- current prices, less the template's promo if it still
/// applies (it's left off if it was deactivated, expired, or the cart no
/// longer earns it).
async function fire(template: RecurringOrderTemplate) {
  const available = (await fetchMenu(template.catalog_ref)).filter((row) => row.item.available);
  // A template repeats an item once per unit; count them back up.
  const lines = template.item_refs.flatMap((ref) => available.filter((row) => bytesEqual(row.hash, ref)).slice(0, 1));
  if (lines.length === 0) return;
  const items = new Map<string, { item_ref: Uint8Array; quantity: number }>();
  for (const row of lines) {
    const key = bytesToHex(row.hash);
    const existing = items.get(key);
    if (existing) existing.quantity += 1;
    else items.set(key, { item_ref: row.hash, quantity: 1 });
  }
  const cartLines: CartLine[] = [...items.values()].map(({ item_ref, quantity }) => {
    const row = lines.find((r) => bytesEqual(r.hash, item_ref))!;
    return { itemRef: item_ref, name: row.item.name, priceCents: row.item.price_cents, quantity };
  });
  const subtotal = cartLines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
  const promo = template.promo_code_ref ? await livePromoDiscount(template.promo_code_ref, template.catalog_ref, cartLines, subtotal) : null;
  await requestDelivery({
    merchant: template.merchant,
    catalog_ref: template.catalog_ref,
    items: [...items.values()],
    order_total: subtotal - (promo?.discount ?? 0),
    dropoff: template.dropoff,
    max_delivery_fee: template.max_delivery_fee,
    special_instructions: template.special_instructions,
    tip_cents: template.tip_cents,
    dropoff_preference: template.dropoff_preference,
    promo_code_ref: promo ? template.promo_code_ref : null,
  });
}

/// What a promo takes off this cart right now, or `null` if it no longer
/// applies -- the same rules the zome prices with.
async function livePromoDiscount(promoRef: Uint8Array, catalogRef: Uint8Array, lines: CartLine[], subtotal: number): Promise<{ discount: number } | null> {
  const promo = decodeEntry<PromoCode>(await getPromoCode(promoRef));
  const now = Date.now() * 1000;
  if (!promo.active || (promo.expires_at !== null && promo.expires_at <= now)) return null;
  const completed = await countMyCompletedOrders(catalogRef).catch(() => 0);
  const { eligible, effect } = evaluatePromo(promo, lines, subtotal, completed);
  return eligible ? { discount: Math.min(effect.subtotalDiscountCents, subtotal) } : null;
}
