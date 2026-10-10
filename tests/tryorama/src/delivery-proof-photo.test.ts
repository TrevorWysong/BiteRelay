// Proves a handoff's evidence -- where it happened, and the photo at the
// door -- is sealed between its two parties: nothing about it is published
// in the clear, the driver and the recipient can open it, and nobody else
// can. And a photo is an inline image, never a link.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, ST_PETE, acceptOrder, testApp } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, driver] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
    testApp,
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
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: actionHash(bidRecord) });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // Pickup -- no photo, the common case. Drop-off -- with a photo at the door.
  const pickupLeg = actionHash(await attestationOf(driver)<HcRecord>("record_leg", { order_ref: orderRef, sequence: 0, kind: "MerchantHandoff", to: merchant.agentPubKey, geo_at_completion: ST_PETE }));
  const fakePhoto = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const dropoffRecord = await attestationOf(driver)<HcRecord>("record_leg", { order_ref: orderRef, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE, photo_data_uri: fakePhoto });
  const dropoffLeg = actionHash(dropoffRecord);
  await assert.rejects(
    attestationOf(driver)("record_leg", { order_ref: orderRef, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE, photo_data_uri: "https://tracker.example/door.png" }),
    /inline PNG, JPEG, WebP or GIF/,
    "a handoff photo is an inline image, never a link",
  );
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // What's published is sealed: no coordinates, no photo.
  const published = JSON.stringify(decodeEntry<Record<string, unknown>>(dropoffRecord), (_, v) => (v instanceof Uint8Array ? `bytes:${v.length}` : v));
  assert.ok(!published.includes("iVBOR") && !published.includes(String(ST_PETE.lat)), "the published handoff holds neither the photo nor the location");
  console.log("[PASS] a handoff's location and photo are never published in the clear");

  // The two parties to each handoff can open it; nobody else can.
  const evidence = (p: typeof customer, leg: Uint8Array) => attestationOf(p)<{ geo: { lat: number }; photo_data_uri: string } | null>("get_handoff_evidence", leg);
  const forCustomer = await evidence(customer, dropoffLeg);
  assert.equal(forCustomer?.photo_data_uri, fakePhoto, "the customer sees the photo of their door");
  assert.equal(forCustomer?.geo.lat, ST_PETE.lat, "and where it was left");
  assert.equal((await evidence(driver, dropoffLeg))?.photo_data_uri, fakePhoto, "so does the driver who took it");
  assert.equal(await evidence(merchant, dropoffLeg), null, "the store can't open the customer's drop-off");
  assert.equal((await evidence(merchant, pickupLeg))?.photo_data_uri, "", "but can open its own pickup, which had no photo");
  assert.equal(await evidence(customer, pickupLeg), null, "and the customer can't open the store's");
  console.log("[PASS] only a handoff's two parties can open its location and photo");
});
