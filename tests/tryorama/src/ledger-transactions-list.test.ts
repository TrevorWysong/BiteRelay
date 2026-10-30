// Proves the "no-skim" transparency dashboard's one real data source:
// list_my_ledger returns every entry on a party's own ledger (not just
// get_balance's figure), for
// both sides of a settlement, and nothing appears for an uninvolved agent.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, collectFromStore, commitAndCook, decodeEntry, handOff, retryUntil, ST_PETE, testApp, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver, stranger] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
    testApp,
    testApp,
  ]);
  const all = [customer, merchant, driver, stranger];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => retryingCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => retryingCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => retryingCaller(p.cells[0], "dispatch");
  const ledgerOf = (p: typeof customer) => retryingCaller(p.cells[0], "ledger");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });
  await profilesOf(stranger)("create_profile", { display_name: "Sam Stranger", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  // Zeroed deliberately, same reasoning as order-total-settlement.test.ts:
  // isolates the transaction count/shape this test actually cares about
  // from the (already-tested-elsewhere) delivery-subsidy split.
  await catalogOf(merchant)("set_delivery_subsidy_percent", { original_action: catalogRef, delivery_subsidy_percent: 0 });
  const menuItemRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 1000, available: true });
  const menuItemRef = actionHash(menuItemRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: merchant.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 1000,
    dropoff: ST_PETE,
    max_delivery_fee: null,
  });
  const orderRef = actionHash(orderRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await acceptOrder(merchant, orderRef, all);

  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRef,
    eta_seconds: 600,
    price_offer: 400,
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: actionHash(bidRecord) });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await commitAndCook(driver, merchant, orderRef, all);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await collectFromStore(driver, merchant, orderRef, all);

  await handOff(driver, customer, orderRef, "CustomerHandoff", all);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await dispatchOf(customer)("complete_delivery", { order_original_action: orderRef });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // Every entry is on its author's own chain: the customer's holds for the
  // food and the driver's pay; the store's collection of the food; the driver's collateral, held and collected
  // back, and their pay.
  type Entry = { kind: Record<string, unknown>; amount: number };
  const ledger = async (p: typeof customer) => (await ledgerOf(p)<{ entries: HcRecord[] }>("list_my_ledger", { before: null })).entries.map((r) => decodeEntry<Entry>(r));
  const kinds = (entries: Entry[]) => entries.map((e) => Object.keys(e.kind)[0]).sort();

  const customerEntries = await ledger(customer);
  assert.deepEqual(kinds(customerEntries), ["Hold", "Hold"], "the customer's ledger holds what they set aside: the food, and their share of the driver's fee");
  assert.equal(customerEntries.reduce((sum, e) => sum + e.amount, 0), 1000 + 400, "the food, and the whole $4.00 fee (this store covers none of it)");
  console.log("[PASS] the customer's ledger shows exactly what they set aside");

  // The store's listing stake (nothing, on this test network); what it set
  // aside checking the driver in -- none of the fee, which it doesn't cover,
  // but the customer's share again in case it kept them waiting -- and
  // collected back once delivered; and the food.
  const merchantEntries = await retryUntil(() => ledger(merchant), (entries) => entries.filter((e) => "Collect" in e.kind).length === 2, 120, 1000);
  // A store whose sweep sees the order finished before its outcome gives
  // the driver's collateral back with a waiver -- nothing moves its way.
  const givenBack = merchantEntries.filter((e) => "Waive" in e.kind);
  assert.ok(givenBack.every((e) => e.amount === 0 && (e.kind.Waive as { portion: string }).portion === "Collateral"), "anything the store waives is only the driver's collateral, back to them");
  assert.deepEqual(kinds(merchantEntries.filter((e) => !("Waive" in e.kind))), ["Collect", "Collect", "Hold", "Stake"], "the store collected the food and its late cover back");
  const net = merchantEntries.reduce((sum, e) => sum + ("Collect" in e.kind ? e.amount : -e.amount), 0);
  assert.equal(net, 1000, "and is up exactly the food");
  console.log("[PASS] the store's ledger shows the food collected");

  const driverEntries = await retryUntil(() => ledger(driver), (entries) => entries.filter((e) => "Collect" in e.kind).length === 2, 120, 1000);
  assert.deepEqual(kinds(driverEntries), ["Collect", "Collect", "Hold"], "the driver held their collateral, then collected it back and the fee");
  console.log("[PASS] the driver's ledger shows their collateral back and the fee");

  assert.equal((await ledger(stranger)).length, 0, "an uninvolved agent has an empty ledger");
  console.log("[PASS] an agent with no part in any order has an empty ledger, not an error");
});
