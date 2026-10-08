// Proves `max_delivery_radius_km` (catalog zome) is actually enforced --
// `request_delivery`'s own coordinator-level pre-check
// (dispatch_coordinator::orders, same best-effort shape and trust tier as
// its existing promo-code/bag-claim-status checks right above it) rejects
// a dropoff past the merchant's own radius, for both a normal cart order
// and a goodie-bag delivery claim finalizing into one. See
// `relay_types::distance_km`'s own doc comment for why this is a
// coordinator-level check, not a `validate()`-level one: the radius is a
// merchant-editable setting (`update_catalog_details`), so a deterministic
// check would only ever see its value *as published*, not whatever the
// merchant has since changed it to.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, ST_PETE, NYC } from "./helpers.js";

await runScenario(async (scenario) => {
  const [merchant, customer, otherMerchant] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const all = [merchant, customer, otherMerchant];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof merchant) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof merchant) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof merchant) => getZomeCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", {
    business_name: "Mo's Kitchen",
    location: ST_PETE,
    max_delivery_radius_km: 5,
  });
  const catalogRef = actionHash(catalogRecord);
  assert.equal(decodeEntry<{ max_delivery_radius_km: number }>(catalogRecord).max_delivery_radius_km, 5);
  console.log("[PASS] publish_catalog accepts and stores a custom max_delivery_radius_km");

  const menuItemRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", {
    catalog_ref: catalogRef,
    name: "Cuban Sandwich",
    price_cents: 1250,
    available: true,
  });
  const menuItemRef = actionHash(menuItemRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  // Within radius -- dropoff is the merchant's own pickup point, distance 0.
  const orderInRange = await dispatchOf(customer)<HcRecord>("request_delivery", {
    merchant: merchant.agentPubKey,
    catalog_ref: catalogRef,
    items: [{ item_ref: menuItemRef, quantity: 1 }],
    order_total: 1250,
    dropoff: ST_PETE,
    max_delivery_fee: 500,
  });
  assert.ok(actionHash(orderInRange));
  console.log("[PASS] request_delivery succeeds for a dropoff within the merchant's delivery radius");

  // Outside radius -- NYC is ~1700km from St. Petersburg, FL, far past the 5km cap.
  await assert.rejects(
    dispatchOf(customer)("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: menuItemRef, quantity: 1 }],
      order_total: 1250,
      dropoff: NYC,
      max_delivery_fee: 500,
    }),
    /past this store's .*delivery radius/,
    "a dropoff far past the merchant's own delivery radius must be rejected",
  );
  console.log("[PASS] request_delivery rejects a dropoff outside the merchant's delivery radius");

  // Same enforcement point also covers a goodie-bag delivery claim
  // finalizing into a DeliveryOrder -- bag deliveries flow through this
  // exact same request_delivery call, not a separate path.
  const bagRecord = await catalogOf(merchant)<HcRecord>("create_goodie_bag", {
    catalog_ref: catalogRef,
    title: "End-of-day goodie bag",
    description: "",
    photo_data_uri: "",
    original_value_cents: 1500,
    price_cents: 500,
    quantity_total: 1,
    pickup_window_start: now + 1_000_000,
    pickup_window_end: now + 7_200_000_000,
    supports_pickup: false,
    supports_delivery: true,
    created_at: now,
  });
  const bagRef = actionHash(bagRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const claimRecord = await catalogOf(customer)<HcRecord>("claim_goodie_bag", {
    bag_ref: bagRef,
    fulfillment: { Delivery: { dropoff: NYC, max_delivery_fee: 300 } },
  });
  const claimRef = actionHash(claimRecord);
  await dhtSync(all, merchant.cells[0].cell_id[0]);
  await catalogOf(merchant)("confirm_claim", claimRef);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await assert.rejects(
    dispatchOf(customer)("request_delivery", {
      merchant: merchant.agentPubKey,
      catalog_ref: catalogRef,
      items: [{ item_ref: bagRef, quantity: 1 }],
      order_total: 500,
      dropoff: NYC,
      max_delivery_fee: 300,
      bag_claim_ref: claimRef,
    }),
    /past this store's .*delivery radius/,
    "a confirmed goodie-bag claim must still respect the merchant's delivery radius when finalized",
  );
  console.log("[PASS] request_delivery rejects a confirmed goodie-bag claim's out-of-radius dropoff too");

  // A catalog published before this field existed (or one that simply
  // omits it) should still work, defaulting to 8km -- never a hard
  // deserialize failure, the same posture every other additive field in
  // this app already has.
  await profilesOf(otherMerchant)("create_profile", { display_name: "Other Merchant", roles: ["Merchant"], created_at: now });
  const defaultCatalogRecord = await catalogOf(otherMerchant)<HcRecord>("publish_catalog", {
    business_name: "Otto's Kitchen",
    location: ST_PETE,
  });
  assert.equal(decodeEntry<{ max_delivery_radius_km: number }>(defaultCatalogRecord).max_delivery_radius_km, 8);
  console.log("[PASS] omitting max_delivery_radius_km from publish_catalog defaults to 8km, not a deserialize error");

  console.log("[PASS] delivery radius enforcement test complete");
});
