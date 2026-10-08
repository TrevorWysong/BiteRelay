// Proves `bag_claim_ref` wiring on both `DeliveryOrder` and `PickupOrder`
// (dispatch zome) -- a claimed goodie bag can be finalized into either
// fulfillment path, reusing the existing bid/matching/driver pipeline
// unchanged for delivery. See `dispatch_integrity::validate_new_order`/
// `validate_new_pickup_order`'s own symmetric bag_claim_ref checks.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [merchant, customer, otherCustomer] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
    { appBundleSource: appSource },
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

  await catalogOf(merchant)("confirm_claim", claimARef);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const orderA = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: merchant.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: bagRefA, quantity: 1 }],
    order_total: 500,
    dropoff: ST_PETE,
    max_delivery_fee: 300,
    bag_claim_ref: claimARef,
  });
  await dhtSync(all, merchant.cells[0].cell_id[0]);
  const decodedA = decodeEntry<{ status: string; bag_claim_ref: Uint8Array }>(orderA);
  assert.equal(decodedA.status, "Open");
  assert.deepEqual([...decodedA.bag_claim_ref], [...claimARef]);
  console.log("[PASS] request_delivery finalizes a Confirmed delivery claim into a real, bag-linked DeliveryOrder");

  // --- Wrong customer: otherCustomer must not be able to spend customer's own claim. ---
  const bagRefB = await makeBag(1);
  const claimBRecord = await catalogOf(customer)<HcRecord>("claim_goodie_bag", {
    bag_ref: bagRefB,
    fulfillment: { Delivery: { dropoff: ST_PETE, max_delivery_fee: 300 } },
  });
  const claimBRef = actionHash(claimBRecord);
  await dhtSync(all, merchant.cells[0].cell_id[0]);
  await catalogOf(merchant)("confirm_claim", claimBRef);
  await dhtSync(all, otherCustomer.cells[0].cell_id[0]);

  await assert.rejects(
    dispatchOf(otherCustomer)("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: bagRefB, quantity: 1 }],
      order_total: 500,
      dropoff: ST_PETE,
      max_delivery_fee: 300,
      bag_claim_ref: claimBRef,
    }),
    "a different agent must not be able to finalize someone else's confirmed claim",
  );
  console.log("[PASS] validate_new_order rejects bag_claim_ref whose customer doesn't match the order's requester");

  // --- Fulfillment mismatch: a Pickup-claimed claim must not finalize a DeliveryOrder, and vice versa. ---
  const bagRefC = await makeBag(2);
  const pickupClaimRecord = await catalogOf(customer)<HcRecord>("claim_goodie_bag", { bag_ref: bagRefC, fulfillment: "Pickup" });
  const pickupClaimRef = actionHash(pickupClaimRecord);
  await dhtSync(all, merchant.cells[0].cell_id[0]);
  await catalogOf(merchant)("confirm_claim", pickupClaimRef);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await assert.rejects(
    dispatchOf(customer)("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: bagRefC, quantity: 1 }],
      order_total: 500,
      dropoff: ST_PETE,
      max_delivery_fee: 300,
      bag_claim_ref: pickupClaimRef,
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
  await catalogOf(merchant)("confirm_claim", deliveryClaimRef);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await assert.rejects(
    dispatchOf(customer)("request_pickup_order", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: bagRefC, quantity: 1 }],
      order_total: 500,
      bag_claim_ref: deliveryClaimRef,
    }),
    "a claim made for Delivery must not finalize a PickupOrder",
  );
  console.log("[PASS] validate_new_pickup_order rejects a Delivery-claimed bag_claim_ref");

  // --- Positive pickup path, for symmetry with the DeliveryOrder happy path above. ---
  const pickupOrder = await dispatchOf(customer)<HcRecord>("request_pickup_order", {
    merchant: merchant.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: bagRefC, quantity: 1 }],
    order_total: 500,
    bag_claim_ref: pickupClaimRef,
  });
  const decodedPickup = decodeEntry<{ status: string; bag_claim_ref: Uint8Array }>(pickupOrder);
  assert.equal(decodedPickup.status, "Placed");
  assert.deepEqual([...decodedPickup.bag_claim_ref], [...pickupClaimRef]);
  console.log("[PASS] request_pickup_order finalizes a Confirmed pickup claim into a real, bag-linked PickupOrder");
});
