// Proves `bag_claim_ref` wiring on both `DeliveryOrder` and `PickupOrder`
// (dispatch zome) -- a claimed goodie bag can be finalized into either
// fulfillment path, reusing the existing bid/matching/driver pipeline
// unchanged for delivery. See `dispatch_integrity::validate_new_order`/
// `validate_new_pickup_order`'s own symmetric bag_claim_ref checks.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, retryUntil, ST_PETE, testApp } from "./helpers.js";

await runScenario(async (scenario) => {
  const [merchant, customer, otherCustomer] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
    testApp,
  ]);
  const all = [merchant, customer, otherCustomer];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof merchant) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof merchant) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof merchant) => getZomeCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(otherCustomer)("create_profile", { display_name: "Otto Other", roles: ["Requester"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  await dhtSync(all, merchant.cells[0].cell_id[0]);

  const windowStart = now + 1_000_000;
  const windowEnd = now + 7_200_000_000;

  async function makeBag(quantityTotal: number) {
    const bagRecord = await catalogOf(merchant)<HcRecord>("create_goodie_bag", {
      catalog_ref: catalogRef,
      title: "End-of-day goodie bag",
      description: "",
      photo_data_uri: "",
      original_value_cents: 1500,
      price_cents: 500,
      quantity_total: quantityTotal,
      pickup_window_start: windowStart,
      pickup_window_end: windowEnd,
      supports_pickup: true,
      supports_delivery: true,
      created_at: now,
    });
    await dhtSync(all, customer.cells[0].cell_id[0]);
    return actionHash(bagRecord);
  }

  // --- Happy path: claim for delivery, confirm, finalize into a real DeliveryOrder. ---
  const bagRefA = await makeBag(2);
  const claimARecord = await catalogOf(customer)<HcRecord>("claim_goodie_bag", {
    bag_ref: bagRefA,
    fulfillment: { Delivery: { dropoff: ST_PETE, max_delivery_fee: 300 } },
  });
  const claimARef = actionHash(claimARecord);
  await dhtSync(all, merchant.cells[0].cell_id[0]);

  await assert.rejects(
    dispatchOf(customer)("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: bagRefA, quantity: 1 }],
      order_total: 500,
      dropoff: ST_PETE,
      max_delivery_fee: 300,
      bag_claim_ref: claimARef,
    }),
    "a Pending (not yet Confirmed) claim must not finalize into an order",
  );
  console.log("[PASS] validate_new_order rejects bag_claim_ref pointing at a Pending claim");

  const claimARefConfirmed = actionHash(await catalogOf(merchant)<HcRecord>("confirm_claim", claimARef));
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // The customer's conductor redeems a confirmed claim by itself.
  const redeemedBy = (claim: Uint8Array) =>
    retryUntil(() => dispatchOf(customer)<Uint8Array | null>("get_my_order_for_claim", claim).catch(() => null), (found) => found !== null, 60, 1000);
  const orderARef = (await redeemedBy(claimARef))!;
  const decodedA = decodeEntry<{ bag_claim_ref: Uint8Array; order_total: number }>(await dispatchOf(customer)<HcRecord>("get_order", orderARef));
  assert.deepEqual([...decodedA.bag_claim_ref], [...claimARefConfirmed], "it cites the store's confirmation");
  assert.equal(decodedA.order_total, 500, "at the bag's price");
  console.log("[PASS] the customer's conductor turns a confirmed delivery claim into a bag-linked DeliveryOrder");

  // --- Wrong customer: otherCustomer must not be able to spend customer's own claim. ---
  const bagRefB = await makeBag(1);
  const claimBRecord = await catalogOf(customer)<HcRecord>("claim_goodie_bag", {
    bag_ref: bagRefB,
    fulfillment: { Delivery: { dropoff: ST_PETE, max_delivery_fee: 300 } },
  });
  const claimBRef = actionHash(claimBRecord);
  await dhtSync(all, merchant.cells[0].cell_id[0]);
  const claimBRefConfirmed = actionHash(await catalogOf(merchant)<HcRecord>("confirm_claim", claimBRef));
  await dhtSync(all, otherCustomer.cells[0].cell_id[0]);

  await assert.rejects(
    dispatchOf(otherCustomer)("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: bagRefB, quantity: 1 }],
      order_total: 500,
      dropoff: ST_PETE,
      max_delivery_fee: 300,
      bag_claim_ref: claimBRefConfirmed,
    }),
    "a different agent must not be able to finalize someone else's confirmed claim",
  );
  console.log("[PASS] validate_new_order rejects bag_claim_ref whose customer doesn't match the order's requester");

  // --- Fulfillment mismatch: a Pickup-claimed claim must not finalize a DeliveryOrder, and vice versa. ---
  const bagRefC = await makeBag(2);
  const pickupClaimRecord = await catalogOf(customer)<HcRecord>("claim_goodie_bag", { bag_ref: bagRefC, fulfillment: "Pickup" });
  const pickupClaimRef = actionHash(pickupClaimRecord);
  await dhtSync(all, merchant.cells[0].cell_id[0]);
  const pickupClaimRefConfirmed = actionHash(await catalogOf(merchant)<HcRecord>("confirm_claim", pickupClaimRef));
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await assert.rejects(
    dispatchOf(customer)("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: bagRefC, quantity: 1 }],
      order_total: 500,
      dropoff: ST_PETE,
      max_delivery_fee: 300,
      bag_claim_ref: pickupClaimRefConfirmed,
    }),
    "a claim made for Pickup must not finalize a DeliveryOrder",
  );
  console.log("[PASS] validate_new_order rejects a Pickup-claimed bag_claim_ref");

  const deliveryClaimRecord = await catalogOf(customer)<HcRecord>("claim_goodie_bag", {
    bag_ref: bagRefC,
    fulfillment: { Delivery: { dropoff: ST_PETE, max_delivery_fee: 300 } },
  });
  const deliveryClaimRef = actionHash(deliveryClaimRecord);
  await dhtSync(all, merchant.cells[0].cell_id[0]);
  const deliveryClaimRefConfirmed = actionHash(await catalogOf(merchant)<HcRecord>("confirm_claim", deliveryClaimRef));
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await assert.rejects(
    dispatchOf(customer)("request_pickup_order", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: bagRefC, quantity: 1 }],
      order_total: 500,
      bag_claim_ref: deliveryClaimRefConfirmed,
    }),
    "a claim made for Delivery must not finalize a PickupOrder",
  );
  console.log("[PASS] validate_new_pickup_order rejects a Delivery-claimed bag_claim_ref");

  // --- Positive pickup path, for symmetry with the DeliveryOrder happy path above. ---
  const pickupOrderRef = (await redeemedBy(pickupClaimRef))!;
  const decodedPickup = decodeEntry<{ bag_claim_ref: Uint8Array }>(await dispatchOf(customer)<HcRecord>("get_pickup_order", pickupOrderRef));
  assert.deepEqual([...decodedPickup.bag_claim_ref], [...pickupClaimRefConfirmed]);
  console.log("[PASS] the customer's conductor turns a confirmed pickup claim into a bag-linked PickupOrder");
});
