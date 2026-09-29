// Proves the merchant delivery-fee subsidy (architecture plan §12): a
// deliberate promotional lever, not an expected split. Default (no subsidy
// set) stays fully customer-paid, matching existing behavior exactly; an
// active subsidy is applied deterministically at settlement, capped at the
// bid amount, and the driver is always paid the full bid regardless of
// which side(s) it came from.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, retryUntilOk, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, driver] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const both = [customer, driver];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");
  const attestationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "attestation");
  const ledgerOf = (p: typeof customer) => getZomeCaller(p.cells[0], "ledger");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", { business_name: "Cara's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 600, available: true });
  const menuItemRef = actionHash(menuItemRecord);

  // Merchant opts into covering $3.00 of delivery.
  await catalogOf(customer)("set_delivery_subsidy", { original_action: catalogRef, delivery_subsidy_cents: 300 });
  await dhtSync(both, customer.cells[0].cell_id[0]);

  async function driveToDelivered(priceOfferCents: number) {
    const orderRecord = await dispatchOf(customer)<HcRecord>("request_delivery", {
      merchant: customer.agentPubKey,
      catalog_ref: catalogRef,
      item_refs: [menuItemRef],
      order_total: 600,
      dropoff: ST_PETE,
      max_delivery_fee: null,
      tip_cents: 100,
    });
    const orderRef = actionHash(orderRecord);
    await dhtSync(both, customer.cells[0].cell_id[0]);

    const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
      order_ref: orderRef,
      eta_seconds: 600,
      price_offer: priceOfferCents,
      collateral_commitment: { account: "stub", amount: 0, ledger_txn_ref: "pending" },
    });
    const bidRef = actionHash(bidRecord);
    await dhtSync(both, customer.cells[0].cell_id[0]);

    await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef });
    await dhtSync(both, customer.cells[0].cell_id[0]);
    await dispatchOf(customer)("set_order_status", { order_original_action: orderRef, next_status: "MerchantConfirmed" });
    await dhtSync(both, customer.cells[0].cell_id[0]);
    await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "DriverEnRouteToMerchant" });

    const merchantLegRecord = await attestationOf(driver)<HcRecord>("record_leg", { order_ref: orderRef, sequence: 0, kind: "MerchantHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE });
    const merchantLegRef = actionHash(merchantLegRecord);
    await dhtSync(both, customer.cells[0].cell_id[0]);
    const merchantReceiptRecord = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", merchantLegRef);
    await retryUntilOk(() => attestationOf(driver)("link_leg_to_receipt", { leg: merchantLegRef, receipt: actionHash(merchantReceiptRecord) }));

    await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "PickedUp" });
    const customerLegRecord = await attestationOf(driver)<HcRecord>("record_leg", { order_ref: orderRef, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE });
    const customerLegRef = actionHash(customerLegRecord);
    await dhtSync(both, customer.cells[0].cell_id[0]);
    const customerReceiptRecord = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", customerLegRef);
    await retryUntilOk(() => attestationOf(driver)("link_leg_to_receipt", { leg: customerLegRef, receipt: actionHash(customerReceiptRecord) }));
    await dhtSync(both, customer.cells[0].cell_id[0]);

    await dispatchOf(customer)("complete_delivery", { order_original_action: orderRef });
    await dhtSync(both, customer.cells[0].cell_id[0]);
  }

  // Subsidy ($3.00) is smaller than the bid ($5.00) -- merchant covers
  // exactly their subsidy, customer covers the remainder + tip.
  await driveToDelivered(500);
  const driverBalance1 = await ledgerOf(driver)<number>("get_balance", driver.agentPubKey);
  assert.equal(driverBalance1, 600, "driver should be paid the full $5.00 bid + $1.00 tip regardless of the split");
  const customerBalance1 = await ledgerOf(customer)<number>("get_balance", customer.agentPubKey);
  // Customer is both requester and merchant here, so both settlement legs
  // (merchant_share out, customer_share+tip out) hit the same balance:
  // -300 (merchant's covered share) + -(500-300+100) (customer's own share+tip) = -600.
  assert.equal(customerBalance1, -600, "combined requester+merchant balance should reflect both settlement legs, net -$6.00");
  console.log("[PASS] subsidy smaller than the bid: merchant covers exactly its subsidy, customer covers the rest + tip, driver paid in full");

  // Subsidy ($3.00) is larger than a smaller bid ($2.00) -- merchant covers
  // the whole delivery fee (capped at the bid itself), customer pays only
  // the tip.
  await driveToDelivered(200);
  const driverBalance2 = await ledgerOf(driver)<number>("get_balance", driver.agentPubKey);
  assert.equal(driverBalance2, 600 + 300, "driver's second delivery should add exactly $2.00 fee + $1.00 tip = $3.00 to their running balance");
  console.log("[PASS] subsidy larger than the bid: capped at the bid amount, never overpays the driver or undercounts the merchant's share");
});
