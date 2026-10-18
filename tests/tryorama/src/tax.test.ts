// Proves sales tax and VAT on orders: a store's rates are its own terms,
// within the network's bounds; an order carries exactly the tax those
// rates put on it -- added on top, or already in the prices -- each item at
// its category's rate, and validation refuses any other tax or total; and
// the receipt says what was charged. Forgeries are written raw (test-utils).
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, decodeEntry, retryUntil, retryUntilOk, testApp, useTestCoordinators } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([testApp, testApp]);
  const all = [customer, merchant];
  await scenario.shareAllAgents();
  for (const player of all) await useTestCoordinators(player, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);

  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Taxed Tavern", location: ST_PETE }));
  const item = (name: string, price_cents: number, tax_category = "") => ({ catalog_ref: store, name, price_cents, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [], modifier_groups: [], tax_category });
  const burger = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", item("Burger", 1000)));
  const beer = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", item("Beer", 500, "Alcohol")));
  const tax = (rates: [string, number][], prices_include_tax = false, tax_registration = "") =>
    call(merchant, "catalog")("set_tax_settings", { original_action: store, tax_rates: rates.map(([category, basis_points]) => ({ category, label: category, basis_points })), prices_include_tax, tax_registration });

  // ===== A store's rates, within bounds =====
  await assert.rejects(tax([["Sales tax", 5001]]), /at most 50%/, "no rate past the network's bound");
  await assert.rejects(tax([["Sales tax", 825], ["Sales tax", 900]]), /one rate/, "each category once");
  await assert.rejects(tax(Array.from({ length: 9 }, (_, i): [string, number] => [`Rate ${i}`, 100])), /at most 8 tax rates/);
  await tax([["Sales tax", 825], ["Alcohol", 2000]], false, "ST-12345");
  await sync();
  console.log("[PASS] a store sets its own tax rates, within the network's bounds");

  // ===== Tax added on top, each item at its category's rate =====
  const items = [{ item_ref: burger, quantity: 1, selections: [] }, { item_ref: beer, quantity: 1, selections: [] }];
  // $10 burger at 8.25% (83c) + $5 beer at 20% ($1): $15 of food, $1.83 tax.
  await assert.rejects(
    call(customer, "dispatch")("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items, order_total: 1500 }),
    /total is now 1683/,
    "the total shown must include the tax",
  );
  const order = actionHash(await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items, order_total: 1683 })));
  const placed = decodeEntry<{ order_total: number; tax_cents: number; catalog_version: Uint8Array; lines: unknown[] }>(await call(customer, "dispatch")<HcRecord>("get_pickup_order", order));
  assert.deepEqual([placed.order_total, placed.tax_cents], [1683, 183]);
  console.log("[PASS] an order carries its store's tax, each item at its rate");

  // ===== Validation recomputes it =====
  const raw = (order_total: number, tax_cents: number) =>
    call(customer, "dispatch")<HcRecord>("create_raw_pickup_order_for_testing", {
      requester: customer.agentPubKey,
      merchant: merchant.agentPubKey,
      catalog_ref: store,
      catalog_version: placed.catalog_version,
      lines: placed.lines,
      order_total,
      tax_cents,
      status: "Placed",
      requested_at: Date.now() * 1000,
      kitchen_note: null,
      promo_code_ref: null,
      bag_claim_ref: null,
      loyalty_proof: [],
    });
  await assert.rejects(raw(1500, 0), /tax_cents must be 183/, "a modified app can't leave the tax off");
  await assert.rejects(raw(1600, 100), /tax_cents must be 183/, "nor understate it");
  await assert.rejects(raw(1500, 183), /order_total must be 1683/, "nor state it and not charge it");
  console.log("[PASS] validation refuses any tax or total but the store's");

  // ===== A goodie bag is taxed at the store's default rate =====
  const now = Date.now() * 1000;
  const bag = actionHash(
    await call(merchant, "catalog")<HcRecord>("create_goodie_bag", {
      catalog_ref: store, title: "Day's end bag", description: "", photo_data_uri: "", original_value_cents: 1500, price_cents: 500, quantity_total: 1,
      pickup_window_start: now + 1_000_000, pickup_window_end: now + 7_200_000_000, supports_pickup: true, supports_delivery: false, created_at: now,
    }),
  );
  await sync();
  const claim = actionHash(await call(customer, "catalog")<HcRecord>("claim_goodie_bag", { bag_ref: bag, fulfillment: "Pickup" }));
  await sync();
  await call(merchant, "catalog")("confirm_claim", claim);
  await sync();
  // The customer's conductor turns the confirmed claim into an order itself.
  const bagOrder = await retryUntil(() => call(customer, "dispatch")<Uint8Array | null>("get_my_order_for_claim", claim).catch(() => null), (found) => found !== null, 60, 1000);
  const bagTerms = decodeEntry<{ order_total: number; tax_cents: number }>(await call(customer, "dispatch")<HcRecord>("get_pickup_order", bagOrder!));
  assert.deepEqual([bagTerms.order_total, bagTerms.tax_cents], [541, 41], "$5 at 8.25%: 41c of tax, added");
  console.log("[PASS] a goodie bag is taxed at the store's default rate");

  // ===== Prices that include tax (VAT) =====
  await tax([["VAT", 2000], ["Alcohol", 2000]], true);
  await sync();
  // £15 including 20% VAT: £2.50 of it is VAT, and the customer pays £15.
  const vatOrder = actionHash(await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items, order_total: 1500 })));
  const vat = decodeEntry<{ order_total: number; tax_cents: number }>(await call(customer, "dispatch")<HcRecord>("get_pickup_order", vatOrder));
  assert.deepEqual([vat.order_total, vat.tax_cents], [1500, 250]);
  console.log("[PASS] with VAT in the prices, the customer pays the price shown, and the VAT in it is recorded");

  // ===== The receipt =====
  await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order }));
  await call(merchant, "dispatch")("mark_ready_for_pickup", order);
  await sync();
  await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", order), 40);
  const receipt = await retryUntilOk(() => call(customer, "dispatch")<{ tax_cents: number; tax_included: boolean; tax_label: string; tax_registration: string; total_cents: number; discount_cents: number }>("get_order_receipt", order));
  assert.deepEqual(
    [receipt.tax_cents, receipt.tax_included, receipt.tax_label, receipt.tax_registration, receipt.total_cents, receipt.discount_cents],
    [183, false, "Sales tax", "ST-12345", 1683, 0],
    "the receipt shows the tax as charged when the order was placed -- not the store's later VAT",
  );
  console.log("[PASS] the receipt states the tax charged, and the store's registration");
});
