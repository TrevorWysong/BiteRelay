// An order's history can branch, and validation sees only the version an
// update changes -- so a customer could cancel on the version from before
// their store accepted, as if it never had. The store's own chain says it
// cooked, so it's paid for the food whichever version was cancelled; and a
// customer who cancelled writes nothing more on the order (ledger_integrity
// `store_cooked`, dispatch_integrity). Forgeries are written raw
// (test-utils), as a modified app would.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { ST_PETE, actionHash, decodeEntry, retryUntil, retryUntilOk, retryingCaller, testApp, useTestCoordinators } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([testApp, testApp]);
  const all = [customer, merchant];
  await scenario.shareAllAgents();
  await useTestCoordinators(customer, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const balance = (p: typeof customer) => call(p, "ledger")<number>("get_balance", p.agentPubKey);

  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 900, available: true }));
  await sync();

  const placed = await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 900 }));
  const order = actionHash(placed);
  await sync();
  const accepted = await retryUntilOk(() => call(merchant, "dispatch")<HcRecord>("accept_pickup_order", { order_original_action: order }));
  await sync();
  const storeBefore = await balance(merchant);

  // The customer cancels on the version from before the store accepted.
  const asPlaced = decodeEntry<Record<string, unknown>>(placed);
  const cancel = (version: Uint8Array) => call(customer, "dispatch")("update_raw_pickup_order_for_testing", { version, order: { ...asPlaced, status: "Cancelled", cancellation: "ByCustomer" } });
  await cancel(order);
  await sync();
  await assert.rejects(cancel(actionHash(accepted)), /writes nothing more/, "nor cancel again on the current version");
  await call(merchant, "dispatch")("mark_ready_for_pickup", order);
  await sync();
  await assert.rejects(call(customer, "dispatch")("complete_pickup", order), /writes nothing more/, "a customer who cancelled can't collect it too");
  console.log("[PASS] a customer who cancelled an order writes nothing more on it");

  // The store, which cooked, is paid for the food.
  await retryUntil(() => call(merchant, "dispatch")("settle_order", order).then(() => balance(merchant)), (b) => b === storeBefore + 900, 60, 1000);
  console.log("[PASS] a store that cooked is paid for the food, whichever version the customer cancelled");
});
