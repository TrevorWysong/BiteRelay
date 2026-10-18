// Proves driver verification: a network names its verifiers, a verifier
// vouches for a driver for no longer than the network allows, and -- where
// the network requires it -- validation refuses a bid without a verifier's
// current word. A verifier withdrawing it stops customers' apps accepting
// the driver at once.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, decodeEntry, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators } from "./helpers.js";

const PRICE = 1200;

await runScenario(async (scenario) => {
  const [customer, merchant, driver, verifier] = await setupPlayersWithProperties(scenario, 4, (keys) => ({ verifiers: [keys[3]], require_verified_drivers: true, verification_days: 30 }));
  const all = [customer, merchant, driver, verifier];
  await useTestCoordinators(driver, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);

  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: PRICE, available: true }));
  await sync();
  const order = actionHash(
    await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: PRICE, dropoff: ST_PETE, max_delivery_fee: null })),
  );
  await sync();
  const open = actionHash(await acceptOrder(merchant, order, all));
  const bid = { order_ref: order, eta_seconds: 600, price_offer: 400 };

  // ===== Unverified: refused, by the app and by validation =====
  await assert.rejects(call(driver, "dispatch")("submit_bid", bid), /verified before they deliver/);
  const raw = (verification: Uint8Array | null) =>
    call(driver, "dispatch")("create_raw_bid_for_testing", { order_ref: open, bidder: driver.agentPubKey, eta_seconds: 600, to_store_seconds: 0, price_offer: 400, collateral: PRICE, status: "Open", created_at: Date.now() * 1000, verification });
  await assert.rejects(raw(null), /verified before they bid/, "a modified app can't skip it");
  const forged = await call(driver, "dispatch")<Uint8Array>("create_raw_verification_for_testing", { driver: driver.agentPubKey, checks: ["Identity"], expires_at: (Date.now() + 86_400_000) * 1000 }).catch((e) => e);
  assert.match(String(forged), /only the network's verifiers/, "nor can a driver vouch for themselves");
  console.log("[PASS] an unverified driver's bids are refused, by the app and by validation");

  // ===== A verifier vouches, for no longer than the network allows =====
  await assert.rejects(call(verifier, "dispatch")("verify_driver", { driver: verifier.agentPubKey, checks: ["Identity"] }), /can't verify themselves/);
  await call(verifier, "dispatch")("verify_driver", { driver: driver.agentPubKey, checks: ["Identity", "DrivingLicence", "Insurance"], days: 400 });
  await sync();
  const view = await retryUntil(
    () => call(driver, "dispatch")<{ action: Uint8Array; checks: string[]; expires_at: number } | null>("driver_verification", driver.agentPubKey),
    (v) => v !== null,
  );
  assert.deepEqual(view!.checks, ["Identity", "DrivingLicence", "Insurance"]);
  assert.ok(view!.expires_at <= (Date.now() + 30 * 86_400_000 + 60_000) * 1000, "capped at the network's 30 days");
  const placed = await call(driver, "dispatch")<HcRecord>("submit_bid", bid);
  assert.ok(Buffer.from(decodeEntry<{ verification: Uint8Array }>(placed).verification).equals(Buffer.from(view!.action)), "the bid cites it");
  console.log("[PASS] a verifier's verification, capped at the network's lifetime, lets a driver bid");

  // ===== Withdrawn: customers' apps stop accepting the driver =====
  await sync();
  const ranked = await retryUntil(() => call(customer, "dispatch")<{ unavailable: string | null }[]>("rank_bids", order), (r) => r.length === 1);
  assert.equal(ranked[0].unavailable, null);
  await call(verifier, "dispatch")("revoke_verification", view!.action);
  await sync();
  assert.equal(await call(driver, "dispatch")("driver_verification", driver.agentPubKey), null, "it no longer stands");
  const after = await retryUntil(() => call(customer, "dispatch")<{ unavailable: string | null }[]>("rank_bids", order), (r) => r[0]?.unavailable !== null);
  assert.match(after[0].unavailable!, /withdrawn/);
  await assert.rejects(call(customer, "dispatch")("accept_bid", { order_original_action: order, bid_action: actionHash(placed) }), /withdrawn/);
  await assert.rejects(call(driver, "dispatch")("revoke_verification", view!.action), "only its verifier withdraws it");
  console.log("[PASS] a withdrawn verification stops customers accepting the driver");
});
