// Proves the "no-skim" transparency dashboard's one real data source:
// list_my_transactions returns the full, individual LedgerTransaction
// records a party is actually in (not just get_balance's folded sum), for
// both sides of a settlement, and nothing appears for an uninvolved agent.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, bytesEqual, retryUntilOk, ST_PETE } from "./helpers.js";

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

  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRef,
    eta_seconds: 600,
    price_offer: 400,
    collateral_commitment: { account: "stub", amount: 0, ledger_txn_ref: "pending" },
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: actionHash(bidRecord) });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(merchant)("set_order_status", { order_original_action: orderRef, next_status: "MerchantConfirmed" });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "DriverEnRouteToMerchant" });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const merchantLegRecord = await attestationOf(driver)<HcRecord>("record_leg", { order_ref: orderRef, sequence: 0, kind: "MerchantHandoff", to: merchant.agentPubKey, geo_at_completion: ST_PETE });
  const merchantLegRef = actionHash(merchantLegRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const merchantReceiptRecord = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", merchantLegRef);
  await retryUntilOk(() => attestationOf(driver)("link_leg_to_receipt", { leg: merchantLegRef, receipt: actionHash(merchantReceiptRecord) }));

  await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "PickedUp" });
  const customerLegRecord = await attestationOf(driver)<HcRecord>("record_leg", { order_ref: orderRef, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE });
  const customerLegRef = actionHash(customerLegRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);
  const customerReceiptRecord = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", customerLegRef);
  await retryUntilOk(() => attestationOf(driver)("link_leg_to_receipt", { leg: customerLegRef, receipt: actionHash(customerReceiptRecord) }));
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await dispatchOf(customer)("complete_delivery", { order_original_action: orderRef });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // Customer paid both the merchant (order_total) and the driver (delivery
  // fee + tip, via the subsidy split) -- two outgoing transactions.
  const customerTxns = await ledgerOf(customer)<{ transactions: HcRecord[]; next_after: number | null }>("list_my_transactions", { after: null });
  assert.equal(customerTxns.transactions.length, 2, "the customer should see both transactions they were a party to");
  const customerDecoded = customerTxns.transactions.map((r) => decodeEntry<{ from: Uint8Array; to: Uint8Array; amount: number; related_order: Uint8Array }>(r));
  assert.ok(customerDecoded.every((t) => bytesEqual(t.from, customer.agentPubKey)), "the customer should be the payer on every one of their transactions here");
  assert.ok(customerDecoded.every((t) => bytesEqual(t.related_order, orderRef)), "both transactions should reference the same order");
  console.log("[PASS] list_my_transactions shows the customer both outgoing payments for this order");

  const merchantTxns = await ledgerOf(merchant)<{ transactions: HcRecord[]; next_after: number | null }>("list_my_transactions", { after: null });
  assert.equal(merchantTxns.transactions.length, 1, "the merchant should see exactly the one transaction paying them");
  const merchantTxn = decodeEntry<{ to: Uint8Array; amount: number }>(merchantTxns.transactions[0]);
  assert.ok(bytesEqual(merchantTxn.to, merchant.agentPubKey));
  assert.equal(merchantTxn.amount, 1000, "the merchant should have been paid the full order_total");
  console.log("[PASS] list_my_transactions shows the merchant their own incoming payment, and only that one");

  const strangerTxns = await ledgerOf(stranger)<{ transactions: HcRecord[]; next_after: number | null }>("list_my_transactions", { after: null });
  assert.equal(strangerTxns.transactions.length, 0, "an uninvolved agent must see zero transactions");
  console.log("[PASS] an agent with no transactions sees an empty list, not an error");
});
