// Goodie-bag claims have no p2p cron either (same reasoning as
// `useRecurringOrderFiring`) -- once a merchant confirms a claim, the
// *customer's own client* is the one that has to author the resulting
// `PickupOrder`/`DeliveryOrder` (every entry is authored on its own agent's
// chain; see `BagClaim`'s Rust doc comment). This hook is that
// finalization step, mounted once in the app shell so it runs whatever
// screen is open.
//
// Each claim is redeemed at most once: before placing an order it asks the
// customer's own chain whether one already redeems the claim
// (`getMyOrderForClaim` -- correct across devices, unlike a local flag),
// and validation rejects a second redemption outright (see
// `dispatch_integrity::checks`), so a race between two devices can't
// double-spend a claim either.
import { getMyBagClaims, getGoodieBag, getCatalog } from "../holochain/zomes/catalog";
import { getMyOrderForClaim, requestPickupOrder, requestDelivery } from "../holochain/zomes/dispatch";
import { decodeEntry, actionHash } from "../holochain/decode";
import { POLL } from "../lib/poll";
import { usePolling } from "../lib/useResource";
import type { BagClaim, GeoPoint, MerchantCatalog, GoodieBag } from "../holochain/types";

export function useClaimFinalization() {
  // `usePolling` runs one tick at a time, so a tick never sees claims the
  // last one is still turning into orders.
  usePolling(finalizeConfirmedClaims, { pollMs: POLL.signalled, refreshOn: (signal) => "ClaimConfirmed" in signal, background: true });
}

async function finalizeConfirmedClaims() {
  const claims = await getMyBagClaims().catch(() => []);
  const confirmed = claims.map((c) => ({ hash: actionHash(c.record), claim: decodeEntry<BagClaim>(c.record), dropoff: c.dropoff })).filter((c) => c.claim.status === "Confirmed");
  for (const { hash, claim, dropoff } of confirmed) {
    try {
      if (await getMyOrderForClaim(hash)) continue;
      await placeOrderForClaim(hash, claim, dropoff);
    } catch {
      // Best-effort, same posture as useRecurringOrderFiring -- a transient
      // failure is retried on the next tick.
    }
  }
}

/// `dropoff` is the claim's opened drop-off (it's stored sealed); `null` for
/// a pickup claim.
async function placeOrderForClaim(claimRef: Uint8Array, claim: BagClaim, dropoff: GeoPoint | null) {
  const bag = decodeEntry<GoodieBag>(await getGoodieBag(claim.bag_ref));
  const catalog = decodeEntry<MerchantCatalog>(await getCatalog(bag.catalog_ref));
  const common = {
    merchant: catalog.owner,
    catalog_ref: bag.catalog_ref,
    items: [{ item_ref: claim.bag_ref, quantity: 1 }],
    order_total: bag.price_cents,
    kitchen_notes: `Goodie bag: ${bag.title}`,
    bag_claim_ref: claimRef,
  };
  if (claim.fulfillment === "Pickup") {
    await requestPickupOrder(common);
  } else if (dropoff) {
    await requestDelivery({ ...common, dropoff, max_delivery_fee: claim.fulfillment.Delivery.max_delivery_fee });
  }
}
