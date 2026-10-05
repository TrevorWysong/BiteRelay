// Goodie-bag claims have no p2p cron either (same reasoning as
// `useRecurringOrderFiring`) -- once a merchant confirms a claim, the
// *customer's own client* is the one that has to author the resulting
// `PickupOrder`/`DeliveryOrder` (Holochain requires every entry be authored
// on its own agent's chain; see `BagClaim`'s own Rust doc comment). This
// hook is that client-side finalization step, mounted once at the app
// shell level so it fires regardless of which screen is open.
//
// Guards against double-finalizing a claim (there's no on-chain
// claim -> order back-link to check) by searching the customer's own
// already-placed pickup/delivery orders for one whose `bag_claim_ref`
// already matches -- DHT-sourced, so it's correct across devices, unlike a
// localStorage flag.
import { useEffect } from "react";
import { getMyBagClaims, getGoodieBag, getCatalog } from "../holochain/zomes/catalog";
import { getMyPickupOrders, getOrdersForRequester, requestPickupOrder, requestDelivery } from "../holochain/zomes/dispatch";
import { myAgentPubKey, onLocalSignal } from "../holochain/client";
import { decodeEntry, actionHash, bytesEqual } from "../holochain/decode";
import type { BagClaim, DeliveryOrder, MerchantCatalog, PickupOrder, GoodieBag } from "../holochain/types";

const POLL_MS = 5000;

export function useClaimFinalization() {
  useEffect(() => {
    let cancelled = false;

    async function finalizeConfirmedClaims() {
      const requester = myAgentPubKey();
      let claimRecords;
      try {
        claimRecords = await getMyBagClaims();
      } catch {
        return;
      }
      const confirmed = claimRecords
        .map((r) => ({ hash: actionHash(r), claim: decodeEntry<BagClaim>(r) }))
        .filter((c) => c.claim.status === "Confirmed");
      if (confirmed.length === 0 || cancelled) return;

      const pickupOrders = await getMyPickupOrders(requester).catch(() => []);
      const deliveryOrders = await getOrdersForRequester(requester).catch(() => []);
      const alreadyFinalized = (claimHash: Uint8Array) =>
        pickupOrders.some((r) => bytesEqual(decodeEntry<PickupOrder>(r).bag_claim_ref, claimHash)) ||
        deliveryOrders.some((r) => bytesEqual(decodeEntry<DeliveryOrder>(r).bag_claim_ref, claimHash));

      for (const { hash, claim } of confirmed) {
        if (cancelled || alreadyFinalized(hash)) continue;
        try {
          const bag = decodeEntry<GoodieBag>(await getGoodieBag(claim.bag_ref));
          const catalog = decodeEntry<MerchantCatalog>(await getCatalog(bag.catalog_ref));
          if (claim.fulfillment === "Pickup") {
            await requestPickupOrder({
              merchant: catalog.owner,
              catalog_ref: bag.catalog_ref,
              item_refs: [claim.bag_ref],
              order_total: bag.price_cents,
              special_instructions: `Goodie bag: ${bag.title}`,
              bag_claim_ref: hash,
            });
          } else {
            await requestDelivery({
              merchant: catalog.owner,
              catalog_ref: bag.catalog_ref,
              item_refs: [claim.bag_ref],
              order_total: bag.price_cents,
              dropoff: claim.fulfillment.Delivery.dropoff,
              max_delivery_fee: claim.fulfillment.Delivery.max_delivery_fee,
              special_instructions: `Goodie bag: ${bag.title}`,
              bag_claim_ref: hash,
            });
          }
        } catch {
          // Best-effort, same posture as useRecurringOrderFiring -- a
          // transient resolve failure just gets retried next poll tick.
        }
      }
    }

    finalizeConfirmedClaims();
    const interval = setInterval(finalizeConfirmedClaims, POLL_MS);
    const unsubscribe = onLocalSignal((signal) => {
      if ("ClaimConfirmed" in signal) finalizeConfirmedClaims();
    });
    return () => {
      cancelled = true;
      clearInterval(interval);
      unsubscribe();
    };
  }, []);
}
