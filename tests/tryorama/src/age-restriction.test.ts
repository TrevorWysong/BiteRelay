// Proves age-restricted items (alcohol, tobacco): a network sells them only
// if it sets the age; they're collected in person, where the store checks
// ID -- never delivered; and the customer confirms their age. Each rule is
// validation's, so a modified app can't skip it.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, appWithProperties, decodeEntry, retryUntilOk, shareAgentsOn, useTestCoordinators, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const app = appWithProperties({ restricted_min_age: 21 });
  const plain = appWithProperties({});
  const [customer, merchant] = await scenario.addPlayersWithApps([app, app]);
  const [elsewhereCustomer, elsewhereMerchant] = await scenario.addPlayersWithApps([plain, plain]);
  await shareAgentsOn([customer.conductor, merchant.conductor], customer.cells[0].cell_id[0]);
  await shareAgentsOn([elsewhereCustomer.conductor, elsewhereMerchant.conductor], elsewhereCustomer.cells[0].cell_id[0]);
  for (const p of [customer, elsewhereCustomer]) await useTestCoordinators(p, ["dispatch"]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const item = (catalog_ref: Uint8Array, name: string, price_cents: number, age_restricted: boolean) => ({ catalog_ref, name, price_cents, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [], modifier_groups: [], tax_category: "", age_restricted });

  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Corner Bar", location: ST_PETE }));
  const beer = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", item(store, "Beer", 500, true)));
  const fries = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", item(store, "Fries", 400, false)));
  await dhtSync([customer, merchant], customer.cells[0].cell_id[0]);
  const items = [{ item_ref: beer, quantity: 1, selections: [] }, { item_ref: fries, quantity: 1, selections: [] }];
  const pickup = (extra: Record<string, unknown>) => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items, order_total: 900, ...extra });

  // ===== Never delivered =====
  await assert.rejects(
    call(customer, "dispatch")("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items, order_total: 900, dropoff: ST_PETE, max_delivery_fee: 600 }),
    /collected in person/,
    "alcohol isn't delivered",
  );

  // ===== Collected, by someone who says they're old enough =====
  await assert.rejects(pickup({}), /21 or older/, "the customer confirms their age");
  const order = actionHash(await retryUntilOk(() => pickup({ age_confirmed: true })));
  const placed = decodeEntry<{ catalog_version: Uint8Array; lines: unknown[]; age_confirmed: boolean }>(await call(customer, "dispatch")<HcRecord>("get_pickup_order", order));
  assert.equal(placed.age_confirmed, true);
  console.log("[PASS] age-restricted items are collected in person, by a customer who confirms their age");

  // ===== And validation holds a modified app to it =====
  const raw = (age_confirmed: boolean) =>
    call(customer, "dispatch")("create_raw_pickup_order_for_testing", {
      requester: customer.agentPubKey, merchant: merchant.agentPubKey, catalog_ref: store, catalog_version: placed.catalog_version, lines: placed.lines,
      order_total: 900, tax_cents: 0, status: "Placed", requested_at: Date.now() * 1000, kitchen_note: null, promo_code_ref: null, bag_claim_ref: null, loyalty_proof: [], age_confirmed,
    });
  await assert.rejects(raw(false), /confirm they're 21 or older/, "a pickup without the age confirmation is refused");
  console.log("[PASS] validation refuses age-restricted items without the customer's confirmation");

  // ===== A network that sets no age sells none =====
  const otherStore = actionHash(await call(elsewhereMerchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Dry Diner", location: ST_PETE }));
  const wine = actionHash(await call(elsewhereMerchant, "catalog")<HcRecord>("add_menu_item", item(otherStore, "Wine", 900, true)));
  await dhtSync([elsewhereCustomer, elsewhereMerchant], elsewhereCustomer.cells[0].cell_id[0]);
  await assert.rejects(
    call(elsewhereCustomer, "dispatch")("request_pickup_order", { merchant: elsewhereMerchant.agentPubKey, catalog_ref: otherStore, items: [{ item_ref: wine, quantity: 1, selections: [] }], order_total: 900, age_confirmed: true }),
    /doesn't sell age-restricted items/,
  );
  console.log("[PASS] a network that sets no age sells no age-restricted items");
});
