// What a lost key was owed and never collected (`dispatch::uncollected_by`):
// what an issuer reissues to a recovered account's new key
// (issuer/src/recovery.ts, docs/RECOVERY.md). It must never overstate it --
// a part the old key collected, reissued too, would be paid twice -- so it
// reads the account's history as validation does, from a head on it.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { actionHash, bytesEqual, ST_PETE, retryUntil, testApp, retryingCaller } from "./helpers.js";

interface Uncollected {
  order: ActionHash;
  hold: ActionHash;
  portion: string;
  amount: number;
  basis: ActionHash;
}

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([testApp, testApp]);
  const all = [customer, merchant];
  await scenario.shareAllAgents();
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  const catalogRef = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE }));
  const itemRef = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 600, available: true }));
  await dhtSync(all, customer.cells[0].cell_id[0]);

  /// A pickup order the store accepts, then the customer cancels while it's
  /// cooking: the store is owed the food.
  const acceptedOrder = async () => {
    const order = actionHash(await call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: catalogRef, items: [{ item_ref: itemRef, quantity: 1 }], order_total: 600 }));
    await dhtSync(all, customer.cells[0].cell_id[0]);
    await call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order });
    await dhtSync(all, customer.cells[0].cell_id[0]);
    return order;
  };
  const headOf = (agent: Uint8Array) => call(customer, "account")<ActionHash | null>("latest_action_of", agent);
  const uncollected = async (agent: Uint8Array, head: ActionHash) => call(customer, "dispatch")<Uncollected[]>("uncollected_by", { agent, head, days: 7 });

  // --- Order A: the store, online, collects what it's owed itself. ---
  const collected = await acceptedOrder();
  await call(customer, "dispatch")("cancel_pickup_order", collected);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await retryUntil(() => call(merchant, "ledger")<number>("get_balance", merchant.agentPubKey), (b) => b === 600, 120, 1000);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const afterCollecting = await headOf(merchant.agentPubKey);
  assert.ok(afterCollecting);
  assert.deepEqual(await uncollected(merchant.agentPubKey, afterCollecting), [], "what it collected isn't owed");
  console.log("[PASS] a part its owner collected isn't counted as owed");

  // --- Order B: the store's device is gone before it can collect. ---
  const stranded = await acceptedOrder();
  // Where its chain stood when it went quiet -- what the issuer reads it
  // from -- then its app stops for good.
  const head = await call(merchant, "account")<ActionHash | null>("latest_action_of", merchant.agentPubKey);
  assert.ok(head);
  await merchant.conductor.adminWs().disableApp({ installed_app_id: merchant.appId });
  await call(customer, "dispatch")("cancel_pickup_order", stranded);
  const owed = await retryUntil(() => uncollected(merchant.agentPubKey, head), (parts) => parts.length > 0, 60, 1000);
  assert.equal(owed.length, 1, "one part, on the one order");
  assert.ok(bytesEqual(owed[0].order, stranded), "the order it was owed on");
  assert.equal(owed[0].portion, "Food");
  assert.equal(owed[0].amount, 600, "priced as collecting it would have paid");
  console.log("[PASS] what a store was owed on an order and never collected is found, priced as collecting it would pay");

  // The customer paid for food cooked: nothing is owed to them.
  const customerHead = await headOf(customer.agentPubKey);
  assert.ok(customerHead);
  assert.deepEqual(await uncollected(customer.agentPubKey, customerHead), [], "the customer is owed nothing");
  console.log("[PASS] nothing is owed to whoever paid for what they got");

  // Read from a head that isn't on the account's chain, it answers nothing.
  await assert.rejects(uncollected(merchant.agentPubKey, customerHead));
  console.log("[PASS] what's owed is read only from a head on the account's own chain");
});
