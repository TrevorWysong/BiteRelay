// Proves a store's listing is backed by money for as long as it stands, so
// nobody can fill a neighbourhood's listings with fakes:
//
// - publishing a store sets aside the network's listing stake, and closing
//   its listing returns it -- taking it out of what customers browse;
// - a listing must be backed by its owner's own stake for that store, and a
//   stake backs one listing;
// - a stake comes back only by citing the deletion of its listing, once;
// - no other link can pose as a listing.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, agentAsLinkBase, bytesEqual, decodeEntry, latestLedgerEntry, retryUntil, setupPlayersWithProperties, ST_PETE, useTestCoordinators, retryingCaller } from "./helpers.js";

const STAKE = 500;

await runScenario(async (scenario) => {
  const [merchant, customer] = await setupPlayersWithProperties(scenario, 2, () => ({ store_listing_stake: STAKE }));
  const all = [merchant, customer];
  for (const p of all) await useTestCoordinators(p, ["catalog", "ledger"]);
  const sync = () => dhtSync(all, merchant.cells[0].cell_id[0]);
  const call = (p: typeof merchant, zome: string) => retryingCaller(p.cells[0], zome);
  const balance = () => call(merchant, "ledger")<number>("get_balance", merchant.agentPubKey);
  /// The stores a customer browsing `geohash` sees.
  const nearby = async (geohash: string) =>
    (await call(customer, "catalog")<{ catalogs: { original_action: Uint8Array }[] }>("get_nearby_merchants", { geohash, after: null })).catalogs.map((c) => c.original_action);
  const listingTag = (stake: Uint8Array) => new Uint8Array([...new TextEncoder().encode("listing:"), ...stake]);

  const now = Date.now() * 1000;
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });

  // ===== Listing sets the stake aside =====
  const published = await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE });
  const store = actionHash(published);
  const area = decodeEntry<{ geohash: string }>(published).geohash;
  const listed = (stores: Uint8Array[]) => stores.some((s) => bytesEqual(s, store));
  await sync();
  assert.equal(await balance(), -STAKE, "listing a store sets its stake aside");
  assert.equal(await call(merchant, "catalog")<boolean>("is_store_listed", store), true);
  await retryUntil(() => nearby(area), listed);
  const stakeEntry = await latestLedgerEntry(merchant);
  const stake = stakeEntry.hash!;
  console.log("[PASS] publishing a store lists it, backed by the network's stake");

  // ===== What validation refuses =====
  const anchor = await call(merchant, "catalog")<Uint8Array>("listing_anchor_for_testing", store);
  const rawLink = (linkType: string, base: Uint8Array, tag: Uint8Array) => call(merchant, "catalog")("test_create_link", { link_type: linkType, base, target: store, tag: Array.from(tag) });
  await assert.rejects(rawLink("GeohashToCatalog", anchor, new Uint8Array()), /names the stake that backs it/, "an unbacked listing");
  await assert.rejects(rawLink("GeohashToCatalog", anchor, listingTag(store)), /backed by its owner's stake/, "one citing something that isn't a stake");
  await assert.rejects(rawLink("GeohashToCatalog", anchor, listingTag(stake)), /a stake backs one listing/, "a second listing on the same stake");
  await assert.rejects(rawLink("OwnerToCatalog", agentAsLinkBase(merchant.agentPubKey), listingTag(stake)), /only a store's listing carries a listing tag/, "another link posing as a listing");
  const forgedUnstake = call(merchant, "ledger")("create_raw_ledger_entry_for_testing", {
    kind: { Unstake: { stake, delisting: store } },
    amount: STAKE,
    balance: stakeEntry.balance + STAKE,
    in_hand: stakeEntry.in_hand,
    previous: stakeEntry.hash,
  });
  await assert.rejects(forgedUnstake, /only once its listing is deleted/, "a stake doesn't come back while its listing stands");
  console.log("[PASS] a listing needs its own stake, and a stake comes back only with its listing gone");

  // ===== Closing returns it =====
  await call(merchant, "catalog")("close_listing", store);
  await sync();
  assert.equal(await balance(), 0, "closing the listing returns the stake");
  assert.equal(await call(merchant, "catalog")<boolean>("is_store_listed", store), false);
  await retryUntil(() => nearby(area), (stores) => !listed(stores));
  const unstaked = await latestLedgerEntry(merchant);
  const delisting = decodeEntry<{ kind: { Unstake: { delisting: Uint8Array } } }>(
    (await call(merchant, "ledger")<{ entries: HcRecord[] }>("list_my_ledger", { before: null })).entries[0],
  ).kind.Unstake.delisting;
  await assert.rejects(
    call(merchant, "ledger")("create_raw_ledger_entry_for_testing", {
      kind: { Unstake: { stake, delisting } },
      amount: STAKE,
      balance: unstaked.balance + STAKE,
      in_hand: unstaked.in_hand,
      previous: unstaked.hash,
    }),
    /comes back once/,
    "nor twice",
  );
  console.log("[PASS] closing a listing returns its stake, once, and takes the store out of browsing");

  // ===== Listing again =====
  await call(merchant, "catalog")("reopen_listing", store);
  await sync();
  assert.equal(await balance(), -STAKE, "listing again sets a fresh stake aside");
  assert.equal(await call(merchant, "catalog")<boolean>("is_store_listed", store), true);
  console.log("[PASS] a store can be listed again, on a fresh stake");
});
