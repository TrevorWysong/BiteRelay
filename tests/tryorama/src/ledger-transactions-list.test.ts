// Proves the "no-skim" transparency dashboard's one real data source:
// list_my_ledger returns every entry on a party's own ledger (not just
// get_balance's figure), for
// both sides of a settlement, and nothing appears for an uninvolved agent.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, retryUntil, retryUntilOk, ST_PETE, acceptOrder, handOff } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver, stranger] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const all = [customer, merchant, driver, stranger];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");
  const attestationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "attestation");
  const ledgerOf = (p: typeof customer) => getZomeCaller(p.cells[0], "ledger");

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
  await dispatchOf(merchant)("set_order_status", { order_original_action: orderRef, next_status: "MerchantConfirmed" });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "DriverEnRouteToMerchant" });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await handOff(driver, merchant, orderRef, "MerchantHandoff", all);

  await dispatchOf(driver)("pick_up_order", orderRef);
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

  const merchantEntries = await retryUntil(() => ledger(merchant), (entries) => entries.length === 1, 120, 1000);
  assert.deepEqual(kinds(merchantEntries), ["Collect"], "the store collected the food, and held nothing (it covers none of the fee)");
  console.log("[PASS] the store's ledger shows the food collected");

  const driverEntries = await retryUntil(() => ledger(driver), (entries) => entries.filter((e) => "Collect" in e.kind).length === 2, 120, 1000);
  assert.deepEqual(kinds(driverEntries), ["Collect", "Collect", "Hold"], "the driver held their collateral, then collected it back and the fee");
  console.log("[PASS] the driver's ledger shows their collateral back and the fee");

  assert.equal((await ledger(stranger)).length, 0, "an uninvolved agent has an empty ledger");
  console.log("[PASS] an agent with no part in any order has an empty ledger, not an error");
});
