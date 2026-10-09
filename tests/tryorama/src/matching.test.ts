// Proves matching end to end against real conductors: an order the store
// accepts is listed under its drop-off's cell, drivers nearby find it by
// looking (they never announce where they are -- there's no presence zome
// at all), a driver far away doesn't, and the customer's bid choice is the
// one on-DHT commit that matters.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, bytesEqual, decodeEntry, retryUntil, waitForSignal, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [requester, providerA, providerB, providerC] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const allPlayers = [requester, providerA, providerB, providerC];
  // DHT gossip sync (dhtSync) proves data has propagated, but remote_signal
  // needs an actual live peer connection, which gossip-based discovery can
  // lag behind. shareAllAgents() short-circuits peer discovery for the test.
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof requester) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof requester) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof requester) => getZomeCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(requester)("create_profile", { display_name: "Rita Requester", roles: ["Requester", "Merchant"], created_at: now });
  await profilesOf(providerA)("create_profile", { display_name: "Dana Driver-A", roles: ["Provider"], created_at: now });
  await profilesOf(providerB)("create_profile", { display_name: "Devon Driver-B", roles: ["Provider"], created_at: now });
  await profilesOf(providerC)("create_profile", { display_name: "Dallas Driver-C (far away)", roles: ["Provider"], created_at: now });

  const catalogRecord = await catalogOf(requester)<HcRecord>("publish_catalog", {
    business_name: "Rita's Kitchen",
    location: ST_PETE,
  });
  const catalogRef = actionHash(catalogRecord);
  const menuItemRecord = await catalogOf(requester)<HcRecord>("add_menu_item", {
    catalog_ref: catalogRef,
    name: "Cuban Sandwich",
    price_cents: 1250,
    available: true,
  });
  const menuItemRef = actionHash(menuItemRecord);

  const orderRecord = await dispatchOf(requester)<HcRecord>("request_delivery", {
    merchant: requester.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 1250,
    dropoff: ST_PETE,
    max_delivery_fee: 500,
  });
  const orderRef = actionHash(orderRecord);
  // Drivers hear of it once the store accepts it -- here the requester is the store.
  await dispatchOf(requester)("accept_delivery_order", { order_original_action: orderRef });

  // Drivers A and B are in the drop-off's neighbourhood; C is in New York.
  const dropoffCell = decodeEntry<{ dropoff_geohash: string }>(orderRecord).dropoff_geohash;
  const NYC_CELL = "dr5reg";
  const feed = (p: typeof requester, cell: string) => dispatchOf(p)<HcRecord[]>("get_open_orders_near", cell);
  const isThisOrder = (records: HcRecord[]) => records.some((r) => decodeEntry<{ requested_at: number }>(r).requested_at === decodeEntry<{ requested_at: number }>(orderRecord).requested_at);
  for (const p of [providerA, providerB]) {
    const nearby = await retryUntil(() => feed(p, dropoffCell), isThisOrder, 40, 500);
    assert.ok(isThisOrder(nearby), "a driver nearby finds the order by looking");
  }
  assert.ok(!isThisOrder(await feed(providerC, NYC_CELL)), "a driver far away doesn't see it");
  await assert.rejects(getZomeCaller(providerA.cells[0], "geo_presence")("announce_online", { location: ST_PETE, capabilities: ["Food"] }), /doesn't exist|not exist|ZomeNotFound|zome/i, "there's no way for a driver to publish where they are");
  console.log("[PASS] drivers nearby find a new order by looking; drivers far away don't; nobody publishes their location");

  // Layer 3: off-DHT bidding, then the one on-DHT commit that matters.
  const bidARecord = await dispatchOf(providerA)<HcRecord>("submit_bid", {
    order_ref: orderRef,
    eta_seconds: 900,
    price_offer: 400,
  });
  const bidBRecord = await dispatchOf(providerB)<HcRecord>("submit_bid", {
    order_ref: orderRef,
    eta_seconds: 1200,
    price_offer: 350,
  });
  const bidARef = actionHash(bidARecord);
  const bidBRef = actionHash(bidBRecord);

  await dhtSync(allPlayers, requester.cells[0].cell_id[0]);
  const bidsPage = await dispatchOf(requester)<{ bids: HcRecord[]; next_after: number | null }>(
    "list_bids_for_order",
    { order_ref: orderRef, after: null },
  );
  assert.equal(bidsPage.bids.length, 2, "both bids should be visible to the requester");
  console.log("[PASS] Off-DHT-negotiation bids both landed as on-DHT Bid entries once submitted");

  const acceptedSignalA = waitForSignal(providerA.appWs, (p) => "BidAccepted" in p, 5000);
  const releasedSignalB = waitForSignal(providerB.appWs, (p) => "BidReleased" in p, 5000);

  const acceptedOrderRecord = await dispatchOf(requester)<HcRecord>("accept_bid", {
    order_original_action: orderRef,
    bid_action: bidARef,
  });

  const [acceptedA, releasedB] = await Promise.all([acceptedSignalA, releasedSignalB]);
  assert.ok(acceptedA, "the winning bidder (providerA) should get a BidAccepted signal");
  assert.ok(releasedB, "the losing bidder (providerB) should get a BidReleased signal");
  assert.ok(bytesEqual(releasedB.BidReleased, bidBRef), "the released signal should reference the losing bid");

  const acceptedOrder = decodeEntry<{ status: string; accepted_bid: Uint8Array | null }>(acceptedOrderRecord);
  assert.equal(acceptedOrder.status, "BidAccepted");
  assert.ok(acceptedOrder.accepted_bid && bytesEqual(acceptedOrder.accepted_bid, bidARef), "order.accepted_bid should be providerA's bid");
  console.log("[PASS] accept_bid: single DHT commit, winner notified, loser released -- matching mechanism proven end to end");
});
