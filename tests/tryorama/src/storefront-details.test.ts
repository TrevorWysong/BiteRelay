// Proves the storefront-depth fields added for the web client (profile
// bio/avatar/phone, provider vehicle credentials, catalog description/
// cuisine/hours/banner, menu item description/photo/category/tags, order
// special_instructions/tip) actually round-trip through the real externs --
// exercising the exact field names/shapes the TS client sends, not just
// that the Rust side compiles.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, retryUntilOk, ST_PETE, acceptOrder } from "./helpers.js";

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

  // --- Profile with bio/avatar/phone ---
  const now = Date.now() * 1000;
  const profileRecord = await profilesOf(customer)<HcRecord>("create_profile", {
    display_name: "Cara Customer",
    roles: ["Requester", "Merchant"],
    created_at: now,
    bio: "I love empanadas",
    avatar_data_uri: "data:image/jpeg;base64,xyz",
    phone: "555-0100",
  });
  const profile = decodeEntry<{ bio: string; avatar_data_uri: string; phone?: string; sealed_phone: unknown }>(profileRecord);
  assert.equal(profile.bio, "I love empanadas");
  assert.equal(profile.avatar_data_uri, "data:image/jpeg;base64,xyz");
  assert.equal(profile.phone, undefined, "the public profile carries no phone in the clear");
  assert.ok(profile.sealed_phone, "the phone is stored sealed");
  assert.equal(await profilesOf(customer)<string | null>("get_my_phone", null), "555-0100", "its owner reads it back");
  console.log("[PASS] create_profile round-trips bio/avatar_data_uri, and the phone only for its owner");

  const driverProfileRecord = await profilesOf(driver)<HcRecord>("create_profile", {
    display_name: "Dana Driver",
    roles: ["Provider"],
    created_at: now,
    bio: "",
    avatar_data_uri: "",
    phone: "",
  });
  const driverProfileHash = actionHash(driverProfileRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);

  // --- Provider credential (vehicle info) ---
  await profilesOf(driver)("register_provider_credential", {
    profile_action: driverProfileHash,
    vehicle_description: "Blue Honda Civic",
    capabilities: ["Food"],
    verified: false,
    license_plate: "ABC-123",
    photo_data_uri: "data:image/jpeg;base64,car",
  });
  await dhtSync(both, customer.cells[0].cell_id[0]);
  const fetchedCredential = await profilesOf(customer)<HcRecord | null>("get_provider_credential_for_profile", driverProfileHash);
  assert.ok(fetchedCredential, "expected the driver's own vehicle credential to be discoverable from just their profile action");
  const credential = decodeEntry<{ license_plate: string; vehicle_description: string }>(fetchedCredential!);
  assert.equal(credential.license_plate, "ABC-123");
  assert.equal(credential.vehicle_description, "Blue Honda Civic");
  console.log("[PASS] register_provider_credential + get_provider_credential_for_profile round-trip correctly");

  // --- Catalog with full storefront details, then update ---
  const catalogRecord = await catalogOf(customer)<HcRecord>("publish_catalog", {
    business_name: "Cara's Kitchen",
    location: ST_PETE,
    description: "Cuban food",
    cuisine_type: "Cuban",
    banner_data_uri: "data:image/jpeg;base64,banner",
    phone: "555-0200",
    address_street: "123 Main St",
    address_city: "St. Petersburg",
    address_state: "FL",
    address_zip: "33710",
    // Mondays 09:00-22:00 in New York.
    weekly_hours: [{ weekday: 1, opens: 540, closes: 1320 }],
    time_zone: "America/New_York",
    prep_minutes: 20,
  });
  const catalogRef = actionHash(catalogRecord);
  type Hours = { weekday: number; opens: number; closes: number }[];
  let catalog = decodeEntry<{ cuisine_type: string; weekly_hours: Hours; time_zone: string; prep_minutes: number; description: string }>(catalogRecord);
  assert.equal(catalog.cuisine_type, "Cuban");
  assert.deepEqual(catalog.weekly_hours, [{ weekday: 1, opens: 540, closes: 1320 }]);
  assert.equal(catalog.time_zone, "America/New_York");
  assert.equal(catalog.prep_minutes, 20);
  console.log("[PASS] publish_catalog round-trips all storefront detail fields");

  const updatedCatalogRecord = await catalogOf(customer)<HcRecord>("update_catalog_details", {
    original_action: catalogRef,
    description: "Updated Cuban food",
    cuisine_type: "Cuban",
    banner_data_uri: "",
    phone: "555-0200",
    address_street: "123 Main St",
    address_city: "St. Petersburg",
    address_state: "FL",
    address_zip: "33710",
    // An overnight shift, Friday into Saturday.
    weekly_hours: [{ weekday: 5, opens: 1080, closes: 120 }],
    time_zone: "America/New_York",
    prep_minutes: 25,
    max_delivery_radius_km: 8,
  });
  catalog = decodeEntry(updatedCatalogRecord);
  assert.equal(catalog.description, "Updated Cuban food");
  assert.deepEqual(catalog.weekly_hours, [{ weekday: 5, opens: 1080, closes: 120 }]);
  assert.equal(catalog.prep_minutes, 25);
  console.log("[PASS] update_catalog_details updates fields correctly");
  // Back to no set hours, so the orders below aren't refused for the time
  // of day this happens to run (store-hours.test.ts covers hours).
  await catalogOf(customer)("update_catalog_details", {
    original_action: catalogRef,
    description: "Updated Cuban food",
    cuisine_type: "Cuban",
    banner_data_uri: "",
    phone: "555-0200",
    address_street: "123 Main St",
    address_city: "St. Petersburg",
    address_state: "FL",
    address_zip: "33710",
    weekly_hours: [],
    time_zone: "America/New_York",
    prep_minutes: 25,
    max_delivery_radius_km: 8,
  });

  // --- Non-owner cannot update catalog details or add menu items ---
  await assert.rejects(
    catalogOf(driver)("update_catalog_details", { original_action: catalogRef, description: "hijacked", cuisine_type: "", banner_data_uri: "", phone: "", address_street: "", address_city: "", address_state: "", address_zip: "", weekly_hours: [], time_zone: "UTC", prep_minutes: 15, max_delivery_radius_km: 8 }),
    "a non-owner must not be able to update someone else's catalog details",
  );
  await assert.rejects(
    catalogOf(driver)("add_menu_item", { catalog_ref: catalogRef, name: "Sneaky item", price_cents: 100, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: [] }),
    "a non-owner must not be able to add a menu item to someone else's catalog",
  );
  console.log("[PASS] validate() rejects catalog/menu-item mutations from a non-owner");

  // --- Menu item with description/photo/category/tags, then update ---
  const itemRecord = await catalogOf(customer)<HcRecord>("add_menu_item", {
    catalog_ref: catalogRef,
    name: "Empanada",
    price_cents: 600,
    available: true,
    description: "Beef empanada",
    photo_data_uri: "data:image/jpeg;base64,item",
    category: "Appetizers",
    dietary_tags: ["Spicy"],
  });
  const itemRef = actionHash(itemRecord);
  let item = decodeEntry<{ category: string; dietary_tags: string[]; price_cents: number; available: boolean }>(itemRecord);
  assert.equal(item.category, "Appetizers");
  assert.deepEqual(item.dietary_tags, ["Spicy"]);
  console.log("[PASS] add_menu_item round-trips description/photo/category/dietary_tags");

  const updatedItemRecord = await catalogOf(customer)<HcRecord>("update_menu_item", { original_action: itemRef, item: { ...item, catalog_ref: catalogRef, name: "Empanada", description: "Beef empanada", photo_data_uri: "data:image/jpeg;base64,item", price_cents: 700, available: false } });
  item = decodeEntry(updatedItemRecord);
  assert.equal(item.price_cents, 700);
  assert.equal(item.available, false);
  console.log("[PASS] update_menu_item updates fields correctly");

  // --- Order with special_instructions/tip ---
  const placeOrder = () =>
    dispatchOf(customer)<HcRecord>("request_delivery", {
      merchant: customer.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: itemRef, quantity: 1 }],
      order_total: 700,
      dropoff: ST_PETE,
      max_delivery_fee: null,
      kitchen_notes: "Extra salsa",
      dropoff_notes: "Ring the bell",
      tip_cents: 150,
    });
  await assert.rejects(placeOrder(), /Empanada is sold out/, "a sold-out item can't be ordered");
  await catalogOf(customer)("update_menu_item", { original_action: itemRef, item: { ...item, available: true } });
  console.log("[PASS] a sold-out item can't be ordered until it's back on the menu");
  const orderRecord = await placeOrder();
  const orderRef = actionHash(orderRecord);
  const order = decodeEntry<{ tip_cents: number }>(orderRecord);
  assert.equal(order.tip_cents, 150);
  const details = await dispatchOf(customer)<{ dropoff: { notes: string } | null; kitchen_note: string | null }>("get_order_private_details", orderRef);
  assert.equal(details.dropoff?.notes, "Ring the bell");
  assert.equal(details.kitchen_note, "Extra salsa");
  console.log("[PASS] request_delivery round-trips tip_cents, and its sealed notes for the customer");

  // --- Drive to Delivered, confirming the tip is actually paid to the driver ---
  await dhtSync(both, customer.cells[0].cell_id[0]);
  await acceptOrder(customer, orderRef, both);
  const bidRecord = await dispatchOf(driver)<HcRecord>("submit_bid", {
    order_ref: orderRef,
    eta_seconds: 900,
    price_offer: 400,
  });
  const bidRef = actionHash(bidRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);

  await dispatchOf(customer)("accept_bid", { order_original_action: orderRef, bid_action: bidRef, override_warrants: false });
  await dispatchOf(customer)("set_order_status", { order_original_action: orderRef, next_status: "MerchantConfirmed" });
  await dhtSync(both, customer.cells[0].cell_id[0]);
  await dispatchOf(driver)("set_order_status", { order_original_action: orderRef, next_status: "DriverEnRouteToMerchant" });

  const attestationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "attestation");
  const merchantLegRecord = await attestationOf(driver)<HcRecord>("record_leg", { order_ref: orderRef, sequence: 0, kind: "MerchantHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE });
  const merchantLegRef = actionHash(merchantLegRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);
  const merchantReceiptRecord = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", merchantLegRef);
  await retryUntilOk(() => attestationOf(driver)("link_leg_to_receipt", { leg: merchantLegRef, receipt: actionHash(merchantReceiptRecord) }));

  await dispatchOf(driver)("pick_up_order", orderRef);
  const customerLegRecord = await attestationOf(driver)<HcRecord>("record_leg", { order_ref: orderRef, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE });
  const customerLegRef = actionHash(customerLegRecord);
  await dhtSync(both, customer.cells[0].cell_id[0]);
  const customerReceiptRecord = await attestationOf(driver)<HcRecord>("initiate_leg_attestation", customerLegRef);
  await retryUntilOk(() => attestationOf(driver)("link_leg_to_receipt", { leg: customerLegRef, receipt: actionHash(customerReceiptRecord) }));
  await dhtSync(both, customer.cells[0].cell_id[0]);

  await dispatchOf(customer)("complete_delivery", { order_original_action: orderRef });
  const ledgerOf = (p: typeof customer) => getZomeCaller(p.cells[0], "ledger");
  await dhtSync(both, customer.cells[0].cell_id[0]);
  const driverBalance = await ledgerOf(driver)<number>("get_balance", driver.agentPubKey);
  assert.equal(driverBalance, 400 + 150, "driver's payout must include the tip on top of the bid's price_offer");
  console.log("[PASS] complete_delivery pays the driver price_offer + tip_cents, confirming the tip is real money, not just a stored field");

  // --- Reviews ---
  const reputationOf = (p: typeof customer) => getZomeCaller(p.cells[0], "reputation");
  await reputationOf(customer)("submit_review", { target: { Driver: driver.agentPubKey }, order_original_action: orderRef, rating: 5, comment: "Great driver!" });
  await dhtSync(both, customer.cells[0].cell_id[0]);
  const driverReviews = (await reputationOf(driver)<{ reviews: HcRecord[] }>("get_reviews_for", { target: { Driver: driver.agentPubKey }, before: null })).reviews;
  assert.equal(driverReviews.length, 1);
  const review = decodeEntry<{ rating: number; comment: string }>(driverReviews[0]);
  assert.equal(review.rating, 5);
  assert.equal(review.comment, "Great driver!");
  console.log("[PASS] submit_review + get_reviews_for round-trip correctly");
});
