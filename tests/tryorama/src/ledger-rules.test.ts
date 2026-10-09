// Proves the ledger accepts only real payments: each is one leg a completed
// order owes, for exactly what it owes, written by the agent paying it. The
// `pay`/`forfeit` externs take any `from`, so every attempt below reaches
// validation -- which is what has to refuse it.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, appSource, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, attacker] = await scenario.addPlayersWithApps([{ appBundleSource: appSource }, { appBundleSource: appSource }, { appBundleSource: appSource }]);
  const all = [customer, merchant, attacker];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(attacker, "profiles")("create_profile", { display_name: "Mallory", roles: ["Requester"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Soup", price_cents: 700, available: true }));
  await sync();

  // One completed pickup: the customer owes the store 700.
  const order = actionHash(await call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity: 1 }], order_total: 700 }));
  await sync();
  await call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order });
  await call(merchant, "dispatch")("mark_ready_for_pickup", order);
  await sync();
  const completed = actionHash(await call(customer, "dispatch")<HcRecord>("complete_pickup", order));
  await sync();
  console.log("[PASS] set up a completed pickup order");

  const pay = (p: typeof customer, fields: Record<string, unknown>) =>
    call(p, "ledger")("pay", { leg: "OrderTotal", related_order: order, basis: completed, from: customer.agentPubKey, to: merchant.agentPubKey, amount: 700, ...fields });

  await assert.rejects(pay(merchant, {}), /authored by the agent paying it/, "the payee can't write the payment to themselves");
  await assert.rejects(pay(attacker, { to: attacker.agentPubKey }), /must match what its leg owes/, "a stranger can't redirect a payment to themselves");
  await assert.rejects(pay(attacker, { from: attacker.agentPubKey, to: merchant.agentPubKey, amount: 1 }), /must match what its leg owes/, "nobody else can pay a different amount on the order");
  await assert.rejects(pay(customer, { leg: "Tip", to: merchant.agentPubKey, amount: 50 }), /owes nothing for that payment leg/, "a pickup owes no tip");
  // A second order, never completed. (Paying the first one again would just
  // return the payment already made -- `pay` is idempotent.)
  const open = actionHash(await call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: item, quantity: 1 }], order_total: 700 }));
  await assert.rejects(pay(customer, { related_order: open, basis: open }), /only paid for once it's PickedUp/, "an order can't be paid before it's complete");
  console.log("[PASS] payments are only accepted from the payer, for exactly what a completed order owes");

  await assert.rejects(
    call(attacker, "ledger")("forfeit", { related_order: order, dispute: completed, from: customer.agentPubKey, to: attacker.agentPubKey, amount: 100 }),
    /only be moved by an arbitrator/,
    "only an arbitrator can move collateral",
  );
  console.log("[PASS] collateral can't be moved without an arbitrator's ruling");

  // The honest payment landed once: the store holds exactly 700.
  const balance = await call(merchant, "ledger")<number>("get_balance", merchant.agentPubKey);
  assert.equal(balance, 700, "the store's balance is exactly the one real payment");
  console.log("[PASS] none of the attempts changed anyone's balance");
});
