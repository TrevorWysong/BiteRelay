// Proves the loyalty-reward backend surface: LoyaltyOrderCount is bounds-
// checked like every other requirement, auto_apply round-trips and
// defaults to false (preserving every existing promo code's behavior),
// and an order referencing a LoyaltyOrderCount+auto_apply code is still
// accepted by dispatch_integrity exactly like any other promo (it only
// ever checks catalog_ref/expires_at/active, never the requirement/reward
// content -- counting "how many times has this customer ordered here" is
// evaluated client-side, same trust tier as every other promo's
// arithmetic -- see PromoRequirement::LoyaltyOrderCount's own doc comment).
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
  const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: merchant.agentPubKey,
    catalog_ref: catalogRef,
    item_refs: [menuItemRef],
    order_total: 850,
    dropoff: ST_PETE,
    max_delivery_fee: null,
    promo_code_ref: loyaltyCodeRef,
  });
  assert.ok(orderRecord, "an order referencing a LoyaltyOrderCount+auto_apply promo code must still be accepted by dispatch_integrity");
  console.log("[PASS] an order referencing a loyalty-shaped promo code is accepted, same as any other promo code");
});
