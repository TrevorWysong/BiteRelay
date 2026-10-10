// Proves the goodie-bag listing + claim + confirm lifecycle (catalog zome)
// end to end -- the scarcity-resolution design documented on `GoodieBag`/
// `BagClaim` themselves (catalog_types): a customer creates a `BagClaim`
// (the `Bid`-shaped half), the merchant's own client (`confirm_claim`) is
// the single authoritative party that decides who gets one of the limited
// `quantity_total`, same shape `accept_bid` already uses.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, bytesEqual, ST_PETE, testApp } from "./helpers.js";

await runScenario(async (scenario) => {
  const [merchant, customerA, customerB] = await scenario.addPlayersWithApps([
    testApp,
    testApp,
    testApp,
  ]);
  const all = [merchant, customerA, customerB];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof merchant) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof merchant) => getZomeCaller(p.cells[0], "catalog");

  const now = Date.now() * 1000;
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });
  await profilesOf(customerA)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(customerB)("create_profile", { display_name: "Bo Customer", roles: ["Requester"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  await dhtSync(all, merchant.cells[0].cell_id[0]);

  const windowStart = now + 1_000_000;
  const windowEnd = now + 7_200_000_000;

  const bagRecord = await catalogOf(merchant)<HcRecord>("create_goodie_bag", {
    catalog_ref: catalogRef,
    title: "End-of-day goodie bag",
    description: "",
    photo_data_uri: "",
    original_value_cents: 1500,
    price_cents: 500,
    quantity_total: 1,
    pickup_window_start: windowStart,
    pickup_window_end: windowEnd,
    supports_pickup: true,
    supports_delivery: true,
    created_at: now,
  });
  const bagRef = actionHash(bagRecord);
  await dhtSync(all, customerA.cells[0].cell_id[0]);
  console.log("[PASS] create_goodie_bag lists a bag with price below original_value");

  const listed = await catalogOf(customerA)<{ original_action: Uint8Array; record: HcRecord }[]>("list_goodie_bags_for_catalog", catalogRef);
  assert.equal(listed.length, 1);
  console.log("[PASS] list_goodie_bags_for_catalog discovers the bag by catalog_ref");

  // Avoid re-implementing geohash encoding in the test -- decode the
  // catalog's own stored geohash field instead, same convention as every
  // other geohash-anchor test in this suite (see e.g. scale-anchors.test.ts).
  const geohash = decodeEntry<{ geohash: string }>(catalogRecord).geohash;
  const nearby = await catalogOf(customerA)<{ original_action: Uint8Array; record: HcRecord }[]>("get_nearby_goodie_bags", { geohash, after: null });
  assert.equal(nearby.length, 1, "get_nearby_goodie_bags should join through GeohashToCatalog and find this bag");
  console.log("[PASS] get_nearby_goodie_bags discovers the bag via the catalog's own geohash anchor");

  await assert.rejects(
    catalogOf(merchant)("claim_goodie_bag", { bag_ref: bagRef, fulfillment: "Pickup" }),
    "a merchant must not be able to claim their own goodie bag",
  );
  console.log("[PASS] validate() rejects a merchant claiming their own bag");

  const claimARecord = await catalogOf(customerA)<HcRecord>("claim_goodie_bag", { bag_ref: bagRef, fulfillment: "Pickup" });
  const claimARef = actionHash(claimARecord);
  await dhtSync(all, merchant.cells[0].cell_id[0]);
  assert.equal(decodeEntry<{ status: string }>(claimARecord).status, "Pending");
  console.log("[PASS] claim_goodie_bag creates a Pending claim");

  const claimBRecord = await catalogOf(customerB)<HcRecord>("claim_goodie_bag", { bag_ref: bagRef, fulfillment: "Pickup" });
  const claimBRef = actionHash(claimBRecord);
  await dhtSync(all, merchant.cells[0].cell_id[0]);

  const pendingForMerchant = await catalogOf(merchant)<HcRecord[]>("list_pending_claims_for_merchant", catalogRef);
  assert.equal(pendingForMerchant.length, 2, "both pending claims should be discoverable by the merchant");
  console.log("[PASS] list_pending_claims_for_merchant discovers every pending claim across this merchant's bags");

  await assert.rejects(
    catalogOf(customerA)("confirm_claim", claimARef),
    "only the bag's own catalog owner may confirm a claim",
  );
  console.log("[PASS] validate() rejects a non-owner confirming a claim");

  const confirmedA = await catalogOf(merchant)<HcRecord>("confirm_claim", claimARef);
  await dhtSync(all, customerA.cells[0].cell_id[0]);
  assert.equal(decodeEntry<{ status: string }>(confirmedA).status, "Confirmed");
  console.log("[PASS] confirm_claim flips a claim to Confirmed");

  await assert.rejects(
    catalogOf(merchant)("confirm_claim", claimARef),
    "confirming an already-Confirmed claim must fail",
  );
  console.log("[PASS] validate() rejects re-confirming an already-Confirmed claim");

  await assert.rejects(
    catalogOf(merchant)("confirm_claim", claimBRef),
    "confirm_claim must refuse past quantity_total (this bag's quantity_total is 1, already spent by customer A)",
  );
  console.log("[PASS] confirm_claim refuses to confirm past quantity_total");

  const claimsForBag = await catalogOf(merchant)<HcRecord[]>("list_claims_for_bag", bagRef);
  assert.equal(claimsForBag.length, 2);
  console.log("[PASS] list_claims_for_bag discovers every claim (confirmed and pending) against one bag");

  // `get_my_bag_claims` resolves to each claim's *latest* state (same
  // `resolve_latest` convention as everywhere else) -- its action hash is
  // now the post-confirm Update, not the original `claimARef` creation
  // hash, so compare decoded content instead of the action hash itself.
  const myClaimsA = await catalogOf(customerA)<{ record: HcRecord; dropoff: unknown }[]>("get_my_bag_claims");
  assert.equal(myClaimsA.length, 1);
  const myClaimA = decodeEntry<{ bag_ref: Uint8Array; status: string }>(myClaimsA[0].record);
  assert.ok(bytesEqual(myClaimA.bag_ref, bagRef));
  assert.equal(myClaimA.status, "Confirmed");
  console.log("[PASS] get_my_bag_claims discovers the customer's own claim");

  // Fulfillment mismatch: this bag supports delivery too, but claiming a
  // bag that supports neither must be rejected.
  const noFulfillmentBag = await catalogOf(merchant)<HcRecord>("create_goodie_bag", {
    catalog_ref: catalogRef,
    title: "Misconfigured bag",
    description: "",
    photo_data_uri: "",
    original_value_cents: 1000,
    price_cents: 400,
    quantity_total: 1,
    pickup_window_start: windowStart,
    pickup_window_end: windowEnd,
    supports_pickup: false,
    supports_delivery: true,
    created_at: now,
  });
  await dhtSync(all, customerA.cells[0].cell_id[0]);
  await assert.rejects(
    catalogOf(customerA)("claim_goodie_bag", { bag_ref: actionHash(noFulfillmentBag), fulfillment: "Pickup" }),
    "claiming Pickup against a bag that only supports_delivery must fail",
  );
  console.log("[PASS] validate() rejects claiming a fulfillment method the bag doesn't support");
});
