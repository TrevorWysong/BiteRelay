// Proves merchant-scoped promo codes, built on the generic
// PromoRequirement/PromoReward split: a valid,
// active plain-discount code is accepted on an order; an inactive one, an
// expired one, and one belonging to a different merchant are all rejected
// deterministically by dispatch_integrity::validate_new_order -- not just
// trusted from the client that claimed them. Also proves the generic shape
// actually covers BOGO and "spend $X get item Y free" deals (not just
// flat percent/off-the-whole-order codes), and that an item-scoped
// requirement/reward can't reference another merchant's menu item.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, decodeEntry, ST_PETE, testApp, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, otherMerchant] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
    testApp,
  ]);
  const all = [customer, merchant, otherMerchant];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => retryingCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => retryingCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => retryingCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(otherMerchant)("create_profile", { display_name: "Other Merchant", roles: ["Merchant"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 1000, available: true });
  const menuItemRef = actionHash(menuItemRecord);
  const drinkRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Soda", price_cents: 250, available: true });
  const drinkRef = actionHash(drinkRecord);

  const otherCatalogRecord = await catalogOf(otherMerchant)<HcRecord>("publish_catalog", { business_name: "Someone Else's", location: ST_PETE });
  const otherCatalogRef = actionHash(otherCatalogRecord);
  const otherMenuItemRecord = await catalogOf(otherMerchant)<HcRecord>("add_menu_item", { catalog_ref: otherCatalogRef, name: "Taco", price_cents: 500, available: true });
  const otherMenuItemRef = actionHash(otherMenuItemRecord);

  // Pricing reads the store's menu and codes; a real customer has always
  // loaded the menu before ordering.
  await dhtSync(all, customer.cells[0].cell_id[0]);

  async function placeOrder(promoRef: Uint8Array | null, orderTotal = 1000, items: { item_ref: Uint8Array; quantity: number }[] = [{ item_ref: menuItemRef, quantity: 1 }]) {
    return dispatchOf(customer)<HcRecord>("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items,
      order_total: orderTotal,
      dropoff: ST_PETE,
      max_delivery_fee: null,
      promo_code_ref: promoRef,
    });
  }

  // No promo code at all -- the baseline, must still work.
  await placeOrder(null);
  console.log("[PASS] an order with no promo code still works");

  // A valid, active plain percent-off-the-order code (requirement: None).
  const activeCodeRecord = await catalogOf(merchant)<HcRecord>("create_promo_code", {
    catalog_ref: catalogRef,
    code: "WELCOME10",
    requirement: "None",
    reward: { PercentOffSubtotal: 10 },
  });
  const activeCodeRef = actionHash(activeCodeRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await placeOrder(activeCodeRef, 900); // 10% off $10.00
  console.log("[PASS] a valid, active plain percent-off code is accepted");

  // An inactive code (created then deactivated).
  const inactiveCodeRecord = await catalogOf(merchant)<HcRecord>("create_promo_code", {
    catalog_ref: catalogRef,
    code: "GONE",
    requirement: "None",
    reward: { FlatOffSubtotal: 200 },
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
    requirement: "None",
    reward: { PercentOffSubtotal: 50 },
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
    requirement: "None",
    reward: { PercentOffSubtotal: 20 },
  });
  const wrongMerchantCodeRef = actionHash(wrongMerchantCodeRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await assert.rejects(placeOrder(wrongMerchantCodeRef, 800), /promo_code_ref does not belong to this order's store/, "a code from a different store must be rejected");
  console.log("[PASS] a promo code belonging to a different merchant is rejected");

  // Only the catalog's own owner may create or deactivate its promo codes.
  await assert.rejects(
    catalogOf(customer)("create_promo_code", { catalog_ref: catalogRef, code: "HIJACK", requirement: "None", reward: { PercentOffSubtotal: 99 } }),
    /a promo code can only be authored by its catalog's own owner/,
    "a non-owner must not be able to create a promo code for someone else's catalog",
  );
  console.log("[PASS] only the catalog's own owner can create promo codes for it");

  // Buy-X-get-Y-free / BOGO: requirement and reward are two independent
  // enums, not a hardcoded "BOGO" promo type -- this is MinimumItemQuantity
  // paired with FreeItem, same machinery as the plain-discount codes above.
  const bogoRecord = await catalogOf(merchant)<HcRecord>("create_promo_code", {
    catalog_ref: catalogRef,
    code: "BOGOEMPANADA",
    requirement: { MinimumItemQuantity: { item_ref: menuItemRef, quantity: 2 } },
    reward: { FreeItem: { item_ref: menuItemRef, quantity: 1 } },
  });
  const bogoRef = actionHash(bogoRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const twoEmpanadas = [{ item_ref: menuItemRef, quantity: 2 }];
  await placeOrder(bogoRef, 1000, twoEmpanadas); // two at $10.00, one free
  await assert.rejects(placeOrder(bogoRef, 2000, twoEmpanadas), /the total is now 1000 cents/, "an order that skips the earned discount must be refused with the real total");
  await assert.rejects(placeOrder(bogoRef, 1000), /doesn't meet the promo code's requirement/, "one empanada doesn't earn a second free");
  console.log("[PASS] a buy-X-get-Y-free (BOGO) deal is priced exactly, and only when earned");

  // "Spend $X, get item Y free" -- MinimumSpend paired with FreeItem, where
  // the reward item differs from whatever triggered the requirement.
  const spendGetRecord = await catalogOf(merchant)<HcRecord>("create_promo_code", {
    catalog_ref: catalogRef,
    code: "FREESODA",
    requirement: { MinimumSpend: 1500 },
    reward: { FreeItem: { item_ref: drinkRef, quantity: 1 } },
  });
  const spendGetRef = actionHash(spendGetRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await placeOrder(spendGetRef, 2000, [{ item_ref: menuItemRef, quantity: 2 }, { item_ref: drinkRef, quantity: 1 }]); // $20.00 + a free drink
  console.log("[PASS] a spend-$X-get-item-Y-free deal takes the free item off the total");

  // An item-scoped requirement or reward can't reference another
  // merchant's menu item -- `item_belongs_to_catalog` must catch this even
  // though the item_ref itself resolves to a perfectly real MenuItem entry.
  await assert.rejects(
    catalogOf(merchant)("create_promo_code", {
      catalog_ref: catalogRef,
      code: "CROSSCATALOG",
      requirement: { MinimumItemQuantity: { item_ref: otherMenuItemRef, quantity: 1 } },
      reward: { PercentOffSubtotal: 10 },
    }),
    /a promo code's item references must be real menu items belonging to the same catalog/,
    "a requirement referencing another merchant's menu item must be rejected",
  );
  await assert.rejects(
    catalogOf(merchant)("create_promo_code", {
      catalog_ref: catalogRef,
      code: "CROSSCATALOG2",
      requirement: "None",
      reward: { FreeItem: { item_ref: otherMenuItemRef, quantity: 1 } },
    }),
    /a promo code's item references must be real menu items belonging to the same catalog/,
    "a reward referencing another merchant's menu item must be rejected",
  );
  console.log("[PASS] item-scoped requirements/rewards can't reference a different merchant's menu item");

  // A real bug, caught by testing: the first version of
  // item_belongs_to_catalog propagated to_app_option's decode *error*
  // (not Ok(None)) when item_ref pointed at an entry that doesn't even
  // deserialize as MenuItem -- surfacing as a generic "missing field"
  // validation failure instead of this function's own clear message. A
  // real PromoCode action hash (not a MenuItem) exercises exactly that
  // decode-failure path, not just "wrong catalog."
  await assert.rejects(
    catalogOf(merchant)("create_promo_code", {
      catalog_ref: catalogRef,
      code: "WRONGTYPE",
      requirement: { MinimumItemQuantity: { item_ref: activeCodeRef, quantity: 1 } },
      reward: { PercentOffSubtotal: 10 },
    }),
    /a promo code's item references must be real menu items belonging to the same catalog/,
    "an item_ref pointing at a real entry of the wrong type (not just the wrong catalog) must be rejected cleanly",
  );
  console.log("[PASS] an item_ref pointing at a non-MenuItem entry (wrong type, not just wrong catalog) is rejected cleanly");

  // Zero quantities/percentages are rejected for the new variants too, same
  // bounds-checking discipline as the original PercentOff/FlatCentsOff pair.
  await assert.rejects(
    catalogOf(merchant)("create_promo_code", {
      catalog_ref: catalogRef,
      code: "ZEROQTY",
      requirement: { MinimumItemQuantity: { item_ref: menuItemRef, quantity: 0 } },
      reward: { PercentOffSubtotal: 10 },
    }),
    /MinimumItemQuantity's quantity must be between one and the most on a line/,
    "a zero-quantity MinimumItemQuantity requirement must be rejected",
  );
  console.log("[PASS] a zero-quantity item requirement is rejected");

  const { promo_codes: codes } = await catalogOf(merchant)<{ promo_codes: { original_action: Uint8Array; record: HcRecord }[] }>("list_promo_codes_for_catalog", { catalog_ref: catalogRef, before: null });
  assert.equal(codes.length, 5, "the merchant should see all 5 codes they successfully created, active or not");
  const decoded = codes.map((v) => decodeEntry<{ code: string; active: boolean; requirement: unknown; reward: unknown }>(v.record));
  assert.equal(decoded.find((d) => d.code === "WELCOME10")?.active, true, "WELCOME10 should still be active");
  assert.equal(decoded.find((d) => d.code === "GONE")?.active, false, "GONE should reflect its deactivation");
  const bogoDecoded = decoded.find((d) => d.code === "BOGOEMPANADA");
  assert.deepEqual(bogoDecoded?.requirement, { MinimumItemQuantity: { item_ref: menuItemRef, quantity: 2 } }, "BOGOEMPANADA's requirement should round-trip exactly");
  assert.deepEqual(bogoDecoded?.reward, { FreeItem: { item_ref: menuItemRef, quantity: 1 } }, "BOGOEMPANADA's reward should round-trip exactly");
  console.log("[PASS] list_promo_codes_for_catalog returns every code the merchant created, with requirement/reward round-tripping exactly");
});
