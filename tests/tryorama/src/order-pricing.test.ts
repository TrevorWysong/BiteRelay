// Proves validation, not the honest coordinator, enforces what an order
// costs: orders are written raw (test-utils' create_raw_pickup_order_for_testing,
// what a modified client could do), so every rejection below comes from
// dispatch_integrity::checks::check_pricing.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, appSource, ST_PETE, useTestCoordinators, testApp } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([testApp, testApp]);
  const both = [customer, merchant];
  await scenario.shareAllAgents();
  for (const player of both) await useTestCoordinators(player, ["dispatch"]);
  const sync = () => dhtSync(both, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const otherStore = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's Tacos", location: ST_PETE }));
  const burger = { catalog_ref: store, name: "Burger", price_cents: 1000, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [] };
  const burgerRef = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", burger));
  const burgerNow = actionHash(await call(merchant, "catalog")<HcRecord>("update_menu_item", { original_action: burgerRef, item: { ...burger, price_cents: 1200 } }));
  const tacoRef = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: otherStore, name: "Taco", price_cents: 500, available: true }));
  await sync();

  const raw = (fields: Record<string, unknown>) =>
    call(customer, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: customer.agentPubKey,
      merchant: merchant.agentPubKey,
      catalog_ref: store,
      lines: [{ item_ref: burgerRef, priced_version: burgerNow, quantity: 2 }],
      order_total: 2400,
      status: "Placed",
      requested_at: Date.now() * 1000,
      kitchen_note: null,
      promo_code_ref: null,
      bag_claim_ref: null,
      loyalty_proof: [],
      ...fields,
    });

  await raw({});
  console.log("[PASS] an order priced exactly from its lines is accepted");

  await assert.rejects(raw({ order_total: 100 }), /order_total must be 2400/, "a total below what the lines cost must be refused");
  await assert.rejects(raw({ order_total: 5000 }), /order_total must be 2400/, "and so must one above it");
  console.log("[PASS] validation recomputes the total and refuses any other");

  await assert.rejects(raw({ lines: [{ item_ref: tacoRef, priced_version: tacoRef, quantity: 1 }], order_total: 500 }), /every item must be on this store's menu/, "another store's item can't be ordered here");
  await assert.rejects(raw({ lines: [{ item_ref: burgerRef, priced_version: tacoRef, quantity: 1 }], order_total: 500 }), /must be a version of its own item/, "a line can't borrow another item's price");
  await assert.rejects(
    raw({ lines: [{ item_ref: burgerRef, priced_version: burgerNow, quantity: 1 }, { item_ref: burgerRef, priced_version: burgerNow, quantity: 1 }] }),
    /only appear on one line/,
    "an item appears on one line",
  );
  await assert.rejects(raw({ lines: [{ item_ref: burgerRef, priced_version: burgerNow, quantity: 0 }], order_total: 0 }), /quantity of at least one/, "a line orders at least one");
  console.log("[PASS] every line must be a real item from this store, priced from its own versions");

  // Validation sees records as they were, so it can't tell an older version
  // from the latest -- the store's acceptance refuses it instead (see
  // store-acceptance.test.ts), and nothing proceeds without that.
  await raw({ lines: [{ item_ref: burgerRef, priced_version: burgerRef, quantity: 2 }], order_total: 2000 });
  console.log("[PASS] a line priced at an older version passes validation -- it's the store's acceptance that refuses it");

  // A loyalty promo needs proof of earlier completed orders here.
  const loyalty = actionHash(
    await call(merchant, "catalog")<HcRecord>("create_promo_code", { catalog_ref: store, code: "REGULAR", requirement: { LoyaltyOrderCount: 1 }, reward: { PercentOffSubtotal: 10 }, expires_at: null, auto_apply: true }),
  );
  await sync();
  await assert.rejects(raw({ promo_code_ref: loyalty, order_total: 2160 }), /loyalty_proof must list exactly the 1 completed orders/, "a loyalty discount needs its proof");
  const someOrder = actionHash(await raw({}));
  await assert.rejects(raw({ promo_code_ref: loyalty, order_total: 2160, loyalty_proof: [someOrder] }), /customer's own order completions/, "placing an order isn't completing one");
  console.log("[PASS] a loyalty discount is only accepted with real completions as proof");
});
