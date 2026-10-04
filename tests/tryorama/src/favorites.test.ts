// Proves favorite restaurants: a real round trip (add -> list -> remove),
// and that `validate_new_favorite` genuinely rejects a link pointing at
// something that isn't a MerchantCatalog -- not just trusted because the
// client claimed it was one. The two authorship checks in
// `profiles_integrity` (base must be the author, delete must be authored
// by the original favoriter) are not independently exercised here: neither
// is reachable through the honest coordinator API (`add_favorite` always
// uses the caller's own pubkey as the link base; `remove_favorite` only
// ever deletes links already scoped to `get_links(me, ...)`) -- the same
// "would need a bypass-coordinator extern, not built for this zome" gap
// named for warrants in the architecture plan's §11.2.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, bytesEqual, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant, otherMerchant] = await scenario.addPlayersWithApps([
    { appBundleSource: appSource },
    { appBundleSource: appSource },
    { appBundleSource: appSource },
  ]);
  const all = [customer, merchant, otherMerchant];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");

  const now = Date.now() * 1000;
  const customerProfile = await profilesOf(customer)<HcRecord>("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(otherMerchant)("create_profile", { display_name: "Olive Owner", roles: ["Merchant"], created_at: now });

  // Two distinct merchants, each with their own single storefront --
  // publish_catalog enforces one storefront per owner, so two favorited
  // restaurants means two separate merchant agents, not one merchant
  // publishing twice.
  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const otherCatalogRecord = await catalogOf(otherMerchant)<HcRecord>("publish_catalog", { business_name: "Olive's Other Spot", location: ST_PETE });
  const otherCatalogRef = actionHash(otherCatalogRecord);
  await dhtSync(all, customer.cells[0].cell_id[0]);

  let favorites = await profilesOf(customer)<Uint8Array[]>("list_favorites", null);
  assert.equal(favorites.length, 0, "a fresh agent should start with no favorites");

  await profilesOf(customer)("add_favorite", catalogRef);
  await profilesOf(customer)("add_favorite", otherCatalogRef);
  favorites = await profilesOf(customer)<Uint8Array[]>("list_favorites", null);
  assert.equal(favorites.length, 2, "both favorited catalogs should appear");
  assert.ok(favorites.some((f) => bytesEqual(f, catalogRef)), "the first favorited catalog should be in the list");
  assert.ok(favorites.some((f) => bytesEqual(f, otherCatalogRef)), "the second favorited catalog should be in the list");
  console.log("[PASS] add_favorite + list_favorites round-trip for multiple restaurants");

  await profilesOf(customer)("remove_favorite", catalogRef);
  favorites = await profilesOf(customer)<Uint8Array[]>("list_favorites", null);
  assert.equal(favorites.length, 1, "removing one favorite should leave exactly the other");
  assert.ok(bytesEqual(favorites[0], otherCatalogRef), "the remaining favorite should be the one not removed");
  console.log("[PASS] remove_favorite removes exactly the targeted favorite, leaving the other");

  // A favorite link's target must actually be a MerchantCatalog -- a
  // Profile's own action hash is a real, valid entry of the wrong type.
  await assert.rejects(
    profilesOf(customer)("add_favorite", actionHash(customerProfile)),
    /a favorite link's target must point at a real MerchantCatalog entry/,
    "favoriting something that isn't a MerchantCatalog must be rejected",
  );
  console.log("[PASS] a favorite link targeting a non-MerchantCatalog entry is rejected");
});
