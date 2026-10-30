// Proves what the DHT publishes about a customer: no name, and an order's
// area, never its exact drop-off or notes; their name goes only to each
// order's store and driver. Those are sealed -- the drop-off to the
// customer and, once a bid is accepted, to that driver alone; the kitchen
// note to the store -- and so are standing orders and delivery claims.
// Every check that something is hidden looks at the raw published bytes,
// not just at what the honest UI reads.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, commitAndCook, decodeEntry, deliveryStatus, retryUntil, ST_PETE, acceptOrder, testApp, retryingCaller } from "./helpers.js";

/// The entry's serialized bytes, as any peer holding the record sees them.
function publishedBytes(record: HcRecord): Buffer {
  const present = (record.entry as { Present: { entry: Uint8Array } }).Present;
  return Buffer.from(present.entry);
}

interface Details {
  dropoff: { point: { lat: number; lon: number }; notes: string; recipient: string } | null;
  kitchen_note: string | null;
  customer_name: string | null;
}

await runScenario(async (scenario) => {
  const [customer, merchant, driver, stranger] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
    testApp,
    testApp,
  ]);
  const all = [customer, merchant, driver, stranger];
  await scenario.shareAllAgents();
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);

  const now = Date.now() * 1000;
  for (const [p, name, roles] of [[customer, "Cara", ["Requester"]], [merchant, "Mo", ["Merchant"]], [driver, "Dana", ["Provider"]], [stranger, "Sly", ["Requester"]]] as const) {
    await call(p, "profiles")("create_profile", { display_name: name, roles, created_at: now });
  }
  // A customer publishes no name; a store's is public.
  const profileOf = async (p: typeof customer) => decodeEntry<{ display_name: string; sealed_name: unknown }>((await call(p, "profiles")<HcRecord | null>("get_profile_for_agent", p.agentPubKey))!);
  const customerProfile = await profileOf(customer);
  assert.equal(customerProfile.display_name, "", "a customer's profile carries no name");
  assert.ok(customerProfile.sealed_name, "it's sealed to them");
  assert.ok(!Buffer.from(JSON.stringify(customerProfile)).includes("Cara"), "nowhere in the clear");
  assert.equal(await call(customer, "profiles")<string | null>("get_my_name", null), "Cara", "they read it back");
  assert.equal((await profileOf(merchant)).display_name, "Mo", "a store's name is public");
  console.log("[PASS] a customer's name isn't published; a store's is");

  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const item = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Soup", price_cents: 800, available: true }));
  await sync();

  // A home a few hundred meters from the store.
  const home = { lat: 27.7701, lon: -82.6389 };
  const orderRecord = await call(customer, "dispatch")<HcRecord>("request_delivery", {
    merchant: merchant.agentPubKey,
    catalog_ref: store,
    items: [{ item_ref: item, quantity: 1 }],
    order_total: 800,
    dropoff: home,
    max_delivery_fee: null,
    kitchen_notes: "Allergic to peanuts",
    dropoff_notes: "Gate code 4417",
  });
  const order = actionHash(orderRecord);
  const published = publishedBytes(orderRecord);
  assert.ok(!published.includes("Gate code 4417") && !published.includes("Allergic to peanuts"), "no note is published in the clear");
  const decoded = decodeEntry<Record<string, unknown>>(orderRecord);
  assert.equal(decoded.dropoff, undefined, "no exact drop-off field is published");
  assert.equal(typeof decoded.dropoff_geohash, "string", "only the drop-off's area is");
  console.log("[PASS] a placed order publishes its drop-off area, never the address or the notes");
  await sync();

  const detailsFor = (p: typeof customer) => call(p, "dispatch")<Details>("get_order_private_details", order);
  const mine = await detailsFor(customer);
  assert.deepEqual(mine.dropoff, { point: home, notes: "Gate code 4417", recipient: "Cara" }, "the customer reads their own drop-off");
  assert.equal(mine.kitchen_note, "Allergic to peanuts");
  const storeView = await detailsFor(merchant);
  assert.equal(storeView.kitchen_note, "Allergic to peanuts", "the store reads the kitchen note");
  assert.equal(storeView.customer_name, "Cara", "and who the order's for");
  assert.equal(storeView.dropoff, null, "but not the address");
  assert.deepEqual(await detailsFor(stranger), { dropoff: null, kitchen_note: null, customer_name: null }, "a stranger reads nothing");
  console.log("[PASS] the customer reads everything, the store only its note, a stranger nothing");

  await acceptOrder(merchant, order, all);
  const bid = actionHash(await call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: order, eta_seconds: 600, price_offer: 400 }));
  await sync();
  assert.equal((await detailsFor(driver)).dropoff, null, "a bidding driver doesn't get the address");
  assert.equal((await detailsFor(driver)).customer_name, null, "or the customer's name");
  await call(customer, "dispatch")("accept_bid", { order_original_action: order, bid_action: bid });
  await sync();
  // The driver's app commits as soon as it hears it won, so by now it may
  // have: only a committed driver may hold the address.
  const won = await detailsFor(driver);
  const status = await deliveryStatus(customer, order);
  assert.ok(won.dropoff === null || status !== "BidAccepted", `winning the bid reveals nothing until the driver commits (${status})`);
  // Committing -- collateral set aside -- is what earns the address; the
  // customer's app shares it as soon as it sees that.
  await commitAndCook(driver, merchant, order, all);
  const driverView = await retryUntil(() => detailsFor(driver), (view) => view.dropoff !== null, 60, 1000);
  assert.deepEqual(driverView.dropoff, { point: home, notes: "Gate code 4417", recipient: "Cara" }, "the committed driver gets the exact drop-off, and who it's for");
  assert.equal(driverView.customer_name, "Cara");
  assert.equal(driverView.kitchen_note, null, "but not the kitchen note");
  assert.equal((await detailsFor(stranger)).dropoff, null, "a stranger still reads nothing");
  const accepted = publishedBytes(await call(stranger, "dispatch")<HcRecord>("get_order", order));
  assert.ok(!accepted.includes("Gate code 4417"), "the accepted order still publishes nothing in the clear");
  console.log("[PASS] only the driver who has committed learns the address, and only then");

  // A standing order keeps its address sealed too.
  const template = await call(customer, "dispatch")<HcRecord>("create_recurring_template", {
    merchant: merchant.agentPubKey,
    catalog_ref: store,
    items: [{ item_ref: item, quantity: 1 }],
    dropoff: home,
    max_delivery_fee: null,
    dropoff_notes: "Gate code 4417",
    recurrence: { Daily: { hour: 9, minute: 0 } },
    time_zone: "America/New_York",
  });
  assert.ok(!publishedBytes(template).includes("Gate code 4417"), "a recurring order's notes aren't published");
  const [view] = await call(customer, "dispatch")<{ details: { dropoff: { lat: number } } | null }[]>("list_my_recurring_templates", null);
  assert.equal(view.details?.dropoff.lat, home.lat, "its owner reads the details back");
  console.log("[PASS] recurring orders store their address sealed");

  // So does a goodie bag claimed for delivery: the store sees "delivery".
  const bag = actionHash(
    await call(merchant, "catalog")<HcRecord>("create_goodie_bag", {
      catalog_ref: store,
      title: "Surprise bag",
      description: "",
      photo_data_uri: "",
      original_value_cents: 1500,
      price_cents: 500,
      quantity_total: 3,
      pickup_window_start: Date.now() * 1000,
      pickup_window_end: Date.now() * 1000 + 3_600_000_000,
      supports_pickup: true,
      supports_delivery: true,
      created_at: Date.now() * 1000,
    }),
  );
  await sync();
  const claim = await call(customer, "catalog")<HcRecord>("claim_goodie_bag", { bag_ref: bag, fulfillment: { Delivery: { dropoff: home, max_delivery_fee: 300 } } });
  const fulfillment = decodeEntry<{ fulfillment: { Delivery: Record<string, unknown> } }>(claim).fulfillment.Delivery;
  assert.equal(fulfillment.dropoff, undefined, "the claim publishes no drop-off");
  assert.ok(fulfillment.sealed_dropoff, "it's sealed to the customer");
  const [myClaim] = await call(customer, "catalog")<{ dropoff: { lat: number } | null }[]>("get_my_bag_claims", null);
  assert.equal(myClaim.dropoff?.lat, home.lat, "the customer reads it back");
  console.log("[PASS] a delivery claim's drop-off is sealed to the customer");
});
