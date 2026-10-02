// Proves merchant-scoped promo codes: a valid, active code is accepted on
// an order; an inactive one, an expired one, and one belonging to a
// different merchant are all rejected deterministically by
// dispatch_integrity::validate_new_order -- not just trusted from the
// client that claimed them.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, otherMerchant] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const all = [customer, merchant, otherMerchant];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(otherMerchant)("create_profile", { display_name: "Other Merchant", roles: ["Merchant"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 1000, available: true });
  const menuItemRef = actionHash(menuItemRecord);

  const otherCatalogRecord = await catalogOf(otherMerchant)<HcRecord>("publish_catalog", { business_name: "Someone Else's", location: ST_PETE });
  const otherCatalogRef = actionHash(otherCatalogRecord);

  async function placeOrder(promoRef: Uint8Array | null, orderTotal = 1000) {
    return dispatchOf(customer)<HcRecord>("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      item_refs: [menuItemRef],
      order_total: orderTotal,
      dropoff: ST_PETE,
      max_delivery_fee: null,
      promo_code_ref: promoRef,
    });
  }

  // No promo code at all -- the baseline, must still work.
  await placeOrder(null);
  console.log("[PASS] an order with no promo code still works");

  // A valid, active code for the right merchant.
  const activeCodeRecord = await catalogOf(merchant)<HcRecord>("create_promo_code", {
    catalog_ref: catalogRef,
    code: "WELCOME10",
    discount: { PercentOff: 10 },
  });
  const activeCodeRef = actionHash(activeCodeRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await placeOrder(activeCodeRef, 900); // 10% off $10.00
  console.log("[PASS] a valid, active promo code for the right merchant is accepted");

  // An inactive code (created then deactivated).
  const inactiveCodeRecord = await catalogOf(merchant)<HcRecord>("create_promo_code", {
    catalog_ref: catalogRef,
    code: "GONE",
    discount: { FlatCentsOff: 200 },
  });
  const inactiveCodeRef = actionHash(inactiveCodeRecord);
  await catalogOf(merchant)("set_promo_code_active", { original_action: inactiveCodeRef, active: false });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await assert.rejects(placeOrder(inactiveCodeRef, 800), /promo code is not active/, "a deactivated promo code must be rejected");
  console.log("[PASS] a deactivated promo code is rejected");

  // An already-expired code.
  const expiredCodeRecord = await catalogOf(merchant)<HcRecord>("create_promo_code", {
    catalog_ref: catalogRef,
    code: "OLDDEAL",
    discount: { PercentOff: 50 },
    expires_at: now - 1_000_000, // 1 second in the past
  });
  const expiredCodeRef = actionHash(expiredCodeRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await assert.rejects(placeOrder(expiredCodeRef, 500), /promo code has expired/, "an expired promo code must be rejected");
  console.log("[PASS] an expired promo code is rejected");

  // A real, active code -- but for a different merchant's catalog.
  const wrongMerchantCodeRecord = await catalogOf(otherMerchant)<HcRecord>("create_promo_code", {
    catalog_ref: otherCatalogRef,
    code: "NOTYOURS",
    discount: { PercentOff: 20 },
  });
  const wrongMerchantCodeRef = actionHash(wrongMerchantCodeRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await assert.rejects(placeOrder(wrongMerchantCodeRef, 800), /promo_code_ref does not belong to this order's merchant/, "a code from a different merchant must be rejected");
  console.log("[PASS] a promo code belonging to a different merchant is rejected");

  // Only the catalog's own owner may create or deactivate its promo codes.
  await assert.rejects(
    catalogOf(customer)("create_promo_code", { catalog_ref: catalogRef, code: "HIJACK", discount: { PercentOff: 99 } }),
    /a promo code can only be authored by its catalog's own owner/,
    "a non-owner must not be able to create a promo code for someone else's catalog",
  );
  console.log("[PASS] only the catalog's own owner can create promo codes for it");

  const codes = await catalogOf(merchant)<HcRecord[]>("list_promo_codes_for_catalog", catalogRef);
  assert.equal(codes.length, 3, "the merchant should see all 3 codes they created, active or not");
  const decoded = codes.map((r) => decodeEntry<{ code: string; active: boolean }>(r));
  assert.equal(decoded.find((d) => d.code === "WELCOME10")?.active, true, "WELCOME10 should still be active");
  assert.equal(decoded.find((d) => d.code === "GONE")?.active, false, "GONE should reflect its deactivation");
  console.log("[PASS] list_promo_codes_for_catalog returns every code the merchant created, reflecting current active state");
});
