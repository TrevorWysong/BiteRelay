// Proves MerchantCatalog.dietary_tags: starts empty, grows as menu items
// with tags are added (a real union across items, not just the latest
// item's own tags), and correctly *shrinks* when an item's tags change --
// proving recompute_dietary_tags genuinely re-derives the union from
// scratch on every menu edit rather than just accumulating tags forever.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [merchant] = await scenario.addPlayersWithApps([{ appBundleSource: appSource }]);
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof merchant) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof merchant) => getZomeCaller(p.cells[0], "catalog");

  const now = Date.now() * 1000;
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);

  async function currentTags(): Promise<string[]> {
    const record = await catalogOf(merchant)<HcRecord>("get_catalog", catalogRef);
    return decodeEntry<{ dietary_tags: string[] }>(record).dietary_tags;
  }

  assert.deepEqual(await currentTags(), [], "a freshly published catalog must start with no dietary tags");
  console.log("[PASS] a fresh catalog has no dietary_tags");

  const item1 = await catalogOf(merchant)<HcRecord>("add_menu_item", {
    catalog_ref: catalogRef,
    name: "Garden Salad",
    price_cents: 800,
    available: true,
    dietary_tags: ["Vegetarian", "Gluten-Free"],
  });
  assert.deepEqual(await currentTags(), ["Gluten-Free", "Vegetarian"], "the catalog's dietary_tags should be the sorted union after the first item");
  console.log("[PASS] adding one menu item with tags populates the catalog's dietary_tags (sorted union)");

  await catalogOf(merchant)("add_menu_item", { catalog_ref: catalogRef, name: "Tofu Bowl", price_cents: 1000, available: true, dietary_tags: ["Vegan"] });
  assert.deepEqual(await currentTags(), ["Gluten-Free", "Vegan", "Vegetarian"], "a second item's tags must union in, not replace, the first item's tags");
  console.log("[PASS] a second menu item's tags union with the first, rather than replacing them");

  // Dropping "Gluten-Free" from the salad (while it still has
  // "Vegetarian") should shrink the catalog's tags accordingly, since no
  // *other* item has "Gluten-Free" -- proves this is a real recompute, not
  // an ever-growing accumulator.
  await catalogOf(merchant)("update_menu_item", {
    original_action: actionHash(item1),
    item: { catalog_ref: catalogRef, name: "Garden Salad", price_cents: 800, available: true, description: "", photo_data_uri: "", category: "", dietary_tags: ["Vegetarian"] },
  });
  assert.deepEqual(await currentTags(), ["Vegan", "Vegetarian"], "removing a tag from one item (with no other item carrying it) must shrink the catalog's dietary_tags");
  console.log("[PASS] removing a tag from one item correctly shrinks the catalog-level union");
});
