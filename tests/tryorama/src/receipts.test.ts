// Proves receipts: a completed order's receipt lists each item at the
// price it was ordered at (not today's), the promo, the total, and the
// ledger entry that paid it -- and only the customer gets one, only
// once the order is complete.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, appSource, retryUntilOk, ST_PETE, testApp } from "./helpers.js";

interface Receipt {
  store_name: string;
  delivery: boolean;
  lines: { item_ref: Uint8Array; name: string; quantity: number; unit_price_cents: number; total_cents: number }[];
  subtotal_cents: number;
  discount_cents: number;
  delivery_fee_cents: number;
  tip_cents: number;
  total_cents: number;
  payments: { leg: string; amount_cents: number; transaction: Uint8Array }[];
}

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([testApp, testApp]);
  const both = [customer, merchant];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(both, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE, address_street: "1 Main St", address_city: "St. Petersburg" }));
  const soup = { catalog_ref: store, name: "Soup", price_cents: 1000, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [] };
  const soupRef = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", soup));
  const promo = actionHash(
    await call(merchant, "catalog")<HcRecord>("create_promo_code", { catalog_ref: store, code: "TEN", requirement: "None", reward: { PercentOffSubtotal: 10 }, expires_at: null, auto_apply: false }),
  );
  await sync();

  const order = actionHash(
    await call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: soupRef, quantity: 2 }], order_total: 1800, promo_code_ref: promo }),
  );
  await sync();
  const receipt = () => call(customer, "dispatch")<Receipt>("get_order_receipt", order);
  await assert.rejects(receipt(), /a receipt is for a collected order/, "no receipt before the order's complete");

  await call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order });
  await call(merchant, "dispatch")("mark_ready_for_pickup", order);
  await sync();
  await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", order), 40);
  // The price goes up afterwards; the receipt keeps what was paid.
  await call(merchant, "catalog")("update_menu_item", { original_action: soupRef, item: { ...soup, price_cents: 1500 } });
  await sync();

  const r = await receipt();
  assert.equal(r.store_name, "Mo's");
  assert.equal(r.delivery, false);
  assert.deepEqual(r.lines, [{ item_ref: soupRef, name: "Soup", quantity: 2, unit_price_cents: 1000, total_cents: 2000, choices: [] }], "each item at the price it was ordered at");
  assert.deepEqual([r.subtotal_cents, r.discount_cents, r.delivery_fee_cents, r.tip_cents, r.total_cents], [2000, 200, 0, 0, 1800]);
  assert.equal(r.payments.length, 1);
  assert.deepEqual([r.payments[0].leg, r.payments[0].amount_cents], ["Food", 1800], "the payment that settled it");
  // The receipt cites the customer's own ledger entry that paid it.
  const ledger = await call(customer, "ledger")<{ entries: HcRecord[] }>("list_my_ledger", { before: null });
  assert.ok(ledger.entries.some((e) => Buffer.from(actionHash(e)).equals(Buffer.from(r.payments[0].transaction))), "the cited payment is on the customer's own ledger");
  console.log("[PASS] a completed order's receipt lists what was paid, at the prices paid, and the transaction that paid it");

  await assert.rejects(call(merchant, "dispatch")("get_order_receipt", order), /only the customer has a receipt/);
  console.log("[PASS] only the customer gets a receipt");
});
