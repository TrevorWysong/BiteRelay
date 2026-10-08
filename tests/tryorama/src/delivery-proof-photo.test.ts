// Proves Leg.photo_data_uri: a photo attached at CustomerHandoff round-trips
// through get_legs_for_order, a Leg recorded with no photo decodes to an
// empty string (not missing/undefined), and this is independent of
// countersigning entirely -- the photo lives on the plain, unilateral `Leg`
// entry, not the dual-signed `ReceiptAttestation`, so this test never needs
// to drive a countersigning session at all (see `Leg.photo_data_uri`'s own
// doc comment for why that's a deliberate design choice, not an oversight).
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, ST_PETE, acceptOrder } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const all = [customer, merchant, driver];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");
  const attestationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "attestation");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(driver)("create_profile", { display_name: "Dana Driver", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
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
    collateral_commitment: { account: "stub", amount: 0, ledger_txn_ref: "pending" },
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: actionHash(bidRecord) });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // Pickup leg -- no photo, the common case.
  const pickupLeg = await attestationOf(driver)<HcRecord>("record_leg", {
    order_ref: orderRef,
    sequence: 0,
    kind: "MerchantHandoff",
    to: merchant.agentPubKey,
    geo_at_completion: ST_PETE,
  });
  assert.equal(decodeEntry<{ photo_data_uri: string }>(pickupLeg).photo_data_uri, "", "a leg recorded with no photo must decode to an empty string, not missing");
  console.log("[PASS] a leg recorded with no photo decodes to an empty string");

  // Drop-off leg -- with a photo, the DoorDash-style convention.
  const fakePhoto = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const dropoffLeg = await attestationOf(driver)<HcRecord>("record_leg", {
    order_ref: orderRef,
    sequence: 1,
    kind: "CustomerHandoff",
    to: customer.agentPubKey,
    geo_at_completion: ST_PETE,
    photo_data_uri: fakePhoto,
  });
  assert.equal(decodeEntry<{ photo_data_uri: string }>(dropoffLeg).photo_data_uri, fakePhoto, "the drop-off leg's photo must round-trip through create_entry exactly");
  console.log("[PASS] a photo attached to a CustomerHandoff leg round-trips exactly");

  await dhtSync(all, customer.cells[0].cell_id[0]);
  const legs = await attestationOf(customer)<HcRecord[]>("get_legs_for_order", orderRef);
  const decoded = legs.map((r) => decodeEntry<{ kind: string; photo_data_uri: string }>(r));
  assert.equal(decoded.length, 2, "both legs should be visible via get_legs_for_order");
  assert.equal(decoded.find((l) => l.kind === "CustomerHandoff")?.photo_data_uri, fakePhoto, "the customer reading get_legs_for_order must see the same photo the driver attached");
  assert.equal(decoded.find((l) => l.kind === "MerchantHandoff")?.photo_data_uri, "", "the pickup leg must still show no photo");
  console.log("[PASS] get_legs_for_order surfaces the photo to the customer, matching what the driver attached");
});
