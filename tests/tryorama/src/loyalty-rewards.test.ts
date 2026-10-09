// Proves the loyalty-reward surface: LoyaltyOrderCount is bounds-checked
// like every other requirement, auto_apply round-trips and defaults to
// false, and a loyalty discount is applied only when earned -- the order
// carries the customer's own completions here as proof, which validation
// counts (see dispatch_integrity::checks).
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([{ appBundleSource: appSource }, { appBundleSource: appSource }]);
  const all = [customer, merchant];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 1000, available: true });
  const menuItemRef = actionHash(menuItemRecord);

  await assert.rejects(
    catalogOf(merchant)("create_promo_code", {
      catalog_ref: catalogRef,
      code: "LOYALTY0",
      requirement: { LoyaltyOrderCount: 0 },
      reward: { PercentOffSubtotal: 10 },
    }),
    /LoyaltyOrderCount must be greater than zero/,
    "a zero-order-count loyalty requirement must be rejected",
  );
  console.log("[PASS] a zero LoyaltyOrderCount requirement is rejected");

  // auto_apply omitted -- must default to false, preserving every
  // existing promo code's "customer must type the code" behavior.
  const manualCode = await catalogOf(merchant)<HcRecord>("create_promo_code", {
    catalog_ref: catalogRef,
    code: "WELCOME10",
    requirement: "None",
    reward: { PercentOffSubtotal: 10 },
  });
  assert.equal(decodeEntry<{ auto_apply: boolean }>(manualCode).auto_apply, false, "auto_apply must default to false when omitted");
  console.log("[PASS] auto_apply defaults to false, unchanged behavior for existing-shaped promo codes");

  const loyaltyCode = await catalogOf(merchant)<HcRecord>("create_promo_code", {
    catalog_ref: catalogRef,
    code: "LOYALTY5",
    requirement: { LoyaltyOrderCount: 5 },
    reward: { PercentOffSubtotal: 15 },
    auto_apply: true,
  });
  const loyaltyCodeRef = actionHash(loyaltyCode);
  const decodedLoyalty = decodeEntry<{ requirement: unknown; auto_apply: boolean }>(loyaltyCode);
  assert.deepEqual(decodedLoyalty.requirement, { LoyaltyOrderCount: 5 });
  assert.equal(decodedLoyalty.auto_apply, true);
  console.log("[PASS] a LoyaltyOrderCount + auto_apply promo code round-trips exactly");

  await dhtSync(all, customer.cells[0].cell_id[0]);
  const deliver = (promo: Uint8Array, total: number) =>
    dispatchOf(customer)<HcRecord>("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: menuItemRef, quantity: 1 }],
      order_total: total,
      dropoff: ST_PETE,
      max_delivery_fee: null,
      promo_code_ref: promo,
    });
  await assert.rejects(deliver(loyaltyCodeRef, 850), /doesn't meet the promo code's requirement/, "a first-time customer hasn't earned a 5th-order discount");
  console.log("[PASS] a loyalty discount is refused to a customer who hasn't earned it");

  // Earn it: complete one pickup here, then a 2nd-order discount applies.
  const secondOrder = actionHash(
    await catalogOf(merchant)<HcRecord>("create_promo_code", { catalog_ref: catalogRef, code: "SECOND10", requirement: { LoyaltyOrderCount: 1 }, reward: { PercentOffSubtotal: 10 }, auto_apply: true }),
  );
  const first = actionHash(await dispatchOf(customer)<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: catalogRef, items: [{ item_ref: menuItemRef, quantity: 1 }], order_total: 1000 }));
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(merchant)("accept_pickup_order", { order_original_action: first });
  await dispatchOf(merchant)("mark_ready_for_pickup", first);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("complete_pickup", first);
  const discounted = decodeEntry<{ order_total: number; loyalty_proof: Uint8Array[] }>(await deliver(secondOrder, 900));
  assert.equal(discounted.order_total, 900, "10% off the second order");
  assert.equal(discounted.loyalty_proof.length, 1, "the order carries its one completion as proof");
  console.log("[PASS] once earned, a loyalty discount is applied -- with the completion that earned it as proof");
});
