// Proves get_nearby_merchants (and anything that fans out from it, like
// get_nearby_goodie_bags) exposes a catalog's *stable* original_action,
// not whatever its latest-resolved Record's own action hash happens to be
// -- see `CatalogView`'s own doc comment for the bug this guards against.
// Found live: a real merchant's menu items/goodie bags silently stopped
// being discoverable from the customer-facing "nearby" read the moment
// they toggled their storefront open/closed or edited its details, even
// though the merchant's own get_my_catalog path (fixed earlier, see
// storefront-details.test.ts) was already correct.
import assert from "node:assert/strict";
import { runScenario, dhtSync } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, decodeEntry, bytesEqual, ST_PETE, testApp, retryingCaller } from "./helpers.js";

await runScenario(async (scenario) => {
  const [merchant, customer] = await scenario.addPlayersWithApps([testApp, testApp]);
  const all = [merchant, customer];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof merchant) => retryingCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof merchant) => retryingCaller(p.cells[0], "catalog");

  const now = Date.now() * 1000;
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const originalCatalogRef = actionHash(catalogRecord);
  const geohash = decodeEntry<{ geohash: string }>(catalogRecord).geohash;
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await catalogOf(merchant)("add_menu_item", { catalog_ref: originalCatalogRef, name: "Empanada", price_cents: 600, available: true });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  await catalogOf(merchant)("create_goodie_bag", {
    catalog_ref: originalCatalogRef,
    title: "End-of-day goodie bag",
    description: "",
    photo_data_uri: "",
    original_value_cents: 1000,
    price_cents: 400,
    quantity_total: 1,
    pickup_window_start: now + 1_000_000,
    pickup_window_end: now + 7_200_000_000,
    supports_pickup: true,
    supports_delivery: false,
    created_at: now,
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  async function nearbyOriginalRef(): Promise<Uint8Array> {
    const page = await catalogOf(customer)<{ catalogs: { original_action: Uint8Array; record: HcRecord }[] }>("get_nearby_merchants", { geohash, after: null });
    assert.equal(page.catalogs.length, 1);
    return page.catalogs[0].original_action;
  }

  const refBeforeEdits = await nearbyOriginalRef();
  assert.ok(bytesEqual(refBeforeEdits, originalCatalogRef), "get_nearby_merchants' original_action should match the catalog's real creation hash");
  console.log("[PASS] get_nearby_merchants exposes the catalog's stable original_action");

  let items = await catalogOf(customer)<{ items: { original_action: Uint8Array; record: HcRecord }[] }>("list_menu_items", { catalog_ref: refBeforeEdits, after: null });
  assert.equal(items.items.length, 1);
  let bags = await catalogOf(customer)<{ original_action: Uint8Array; record: HcRecord }[]>("get_nearby_goodie_bags", { geohash, after: null });
  assert.equal(bags.length, 1);
  console.log("[PASS] menu items and goodie bags are discoverable via get_nearby_merchants' original_action before any catalog edit");

  // Edit the catalog twice (each update_entry advances its own "latest"
  // action hash further) -- the bug this test exists to catch only shows
  // up once the catalog's latest state has actually diverged from its
  // original creation hash.
  await catalogOf(merchant)("set_catalog_open", { original_action: originalCatalogRef, is_open: false });
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await catalogOf(merchant)("update_catalog_details", {
    original_action: originalCatalogRef,
    description: "Updated",
    cuisine_type: "",
    banner_data_uri: "",
    phone: "",
    address_street: "",
    address_city: "",
    address_state: "",
    address_zip: "",
    weekly_hours: [],
    time_zone: "UTC",
    prep_minutes: 15,
    max_delivery_radius_km: 8,
  });
  await dhtSync(all, customer.cells[0].cell_id[0]);

  const refAfterEdits = await nearbyOriginalRef();
  assert.ok(bytesEqual(refAfterEdits, originalCatalogRef), "original_action must stay the same even after the catalog's latest state has changed twice");
  console.log("[PASS] get_nearby_merchants' original_action is stable across catalog edits");

  items = await catalogOf(customer)<{ items: { original_action: Uint8Array; record: HcRecord }[] }>("list_menu_items", { catalog_ref: refAfterEdits, after: null });
  assert.equal(items.items.length, 1, "the menu item added before any edit must still be discoverable after the catalog has been edited");
  bags = await catalogOf(customer)<{ original_action: Uint8Array; record: HcRecord }[]>("get_nearby_goodie_bags", { geohash, after: null });
  assert.equal(bags.length, 1, "the goodie bag created before any edit must still be discoverable after the catalog has been edited");
  console.log("[PASS] menu items and goodie bags remain discoverable via get_nearby_merchants after the catalog has been edited -- the real bug this test guards against");
});
