// Proves the ledger's rules, on a network that extends no credit (the
// production setting): funds come only from an issuer; an empty account
// can't order; every balance is the arithmetic of its owner's own chain --
// nobody can state one, skip a debit, or rewrite their history; and a held
// payment's parts are collected only by whoever is owed them, once, on
// proof. Forgeries are written raw (test-utils), as a modified client would.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, latestLedgerEntry, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators } from "./helpers.js";

interface HoldView {
  hold: Uint8Array;
  shares: { portion: string; recipient: Uint8Array; amount: number }[];
}

await runScenario(async (scenario) => {
  const [issuer, customer, merchant, stranger] = await setupPlayersWithProperties(scenario, 4, (keys) => ({ issuers: [keys[0]], credit_limit_cents: 0 }));
  const all = [issuer, customer, merchant, stranger];
  for (const p of [customer, merchant, stranger]) await useTestCoordinators(p, ["ledger"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);
  const balance = (p: typeof customer) => call(p, "ledger")<number>("get_balance", p.agentPubKey);
  const forge = (p: typeof customer, kind: unknown, amount: number, balanceAfter: number, previous: Uint8Array | null) =>
    call(p, "ledger")("create_raw_ledger_entry_for_testing", { kind, amount, balance: balanceAfter, previous });

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const soup = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Soup", price_cents: 1000, available: true }));
  await sync();
  const order = () => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: soup, quantity: 1 }], order_total: 1000 });

  // --- No credit: an empty account can't order. ---
  await assert.rejects(order(), /Not enough funds/);
  console.log("[PASS] with no credit, an empty account can't place an order");

  // --- Funds come only from an issuer, collected once. ---
  await assert.rejects(call(stranger, "ledger")("issue_grant", { to: stranger.agentPubKey, amount: 1_000_000, reference: "free money" }), /only an issuer/);
  const grant = await call(issuer, "ledger")<Uint8Array>("issue_grant", { to: customer.agentPubKey, amount: 5000, reference: "payment-1" });
  await sync();
  assert.equal(await retryUntilOk(() => call(customer, "ledger")<number>("collect_grants", null).then((n) => (n === 1 ? n : Promise.reject(new Error("not yet"))))), 1);
  assert.equal(await call(customer, "ledger")("collect_grants", null), 0, "collecting again collects nothing");
  assert.equal(await balance(customer), 5000);
  const afterDeposit = await latestLedgerEntry(customer);
  await assert.rejects(forge(customer, { Deposit: { grant } }, 5000, 10_000, afterDeposit.hash), /already been collected/, "a grant can't be collected twice");
  console.log("[PASS] funds come only from an issuer, and each grant is collected once");

  // --- Ordering sets the food aside, in the same commit. ---
  const orderRef = actionHash(await order());
  assert.equal(await balance(customer), 4000, "the food is held as the order is placed");
  await sync();
  const [hold] = await retryUntil(() => call(merchant, "ledger")<HoldView[]>("holds_for_order", orderRef), (holds) => holds.length === 1);
  assert.deepEqual(hold.shares.map((s) => [s.portion, s.amount]), [["Food", 1000]]);
  console.log("[PASS] placing an order holds its food in the same commit");

  // --- A balance is the arithmetic of its owner's chain. ---
  const latest = await latestLedgerEntry(customer);
  await assert.rejects(forge(customer, { Deposit: { grant } }, 0, 1_000_000, latest.hash), /must collect|balance must follow/, "nobody states their own balance");
  await assert.rejects(forge(customer, { Waive: { hold: hold.hold, portion: "Food" } }, 0, 4000, afterDeposit.hash), /latest ledger entry/, "nobody skips a debit by chaining from before it");
  await assert.rejects(forge(customer, { Waive: { hold: hold.hold, portion: "Food" } }, 0, 4000, null), /latest ledger entry/, "nor by starting their ledger over");
  await assert.rejects(forge(customer, { Hold: { order: orderRef, purpose: "Food" } }, 1000, 3000 - 2000, latest.hash), /balance must follow/);
  await assert.rejects(forge(customer, { Hold: { order: orderRef, purpose: "Food" } }, 5000, 4000 - 5000, latest.hash), /credit limit/, "nor spends past the credit limit");
  console.log("[PASS] a balance can't be stated, a debit can't be skipped, the history can't be restarted, and the credit limit holds");

  // --- A part of a hold is collected only by whoever is owed it, on proof, once. ---
  const strangerLatest = await latestLedgerEntry(stranger);
  await assert.rejects(forge(stranger, { Waive: { hold: hold.hold, portion: "Food" } }, 0, strangerLatest.balance, strangerLatest.hash), /only a part's recipient/);
  await assert.rejects(forge(stranger, { Collect: { hold: hold.hold, portion: "Food", basis: orderRef } }, 1000, strangerLatest.balance + 1000, strangerLatest.hash), /grounds|doesn't entitle/, "a stranger collects nothing");
  await assert.rejects(forge(customer, { Collect: { hold: hold.hold, portion: "Food", basis: orderRef } }, 1000, latest.balance + 1000, latest.hash), /grounds|doesn't entitle/, "the customer can't take their payment back on their own say");
  const merchantLatest = await latestLedgerEntry(merchant);
  await assert.rejects(forge(merchant, { Collect: { hold: hold.hold, portion: "Food", basis: orderRef } }, 1000, merchantLatest.balance + 1000, merchantLatest.hash), /doesn't entitle/, "the store can't collect before the customer has the food");
  console.log("[PASS] nobody collects a held payment they aren't owed, and the store not before the customer has the order");

  // --- The store accepts (citing the hold); the customer collects; the store is paid. ---
  await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: orderRef }));
  await call(merchant, "dispatch")("mark_ready_for_pickup", orderRef);
  await sync();
  await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", orderRef), 40);
  await sync();
  // The store's conductor collects on its own when the order changes.
  assert.equal(await retryUntil(() => balance(merchant), (b) => b === 1000, 120, 1000), 1000);
  assert.equal(await balance(customer), 4000, "the customer paid exactly the food");
  const merchantAfter = await latestLedgerEntry(merchant);
  await assert.rejects(forge(merchant, { Collect: { hold: hold.hold, portion: "Food", basis: orderRef } }, 1000, merchantAfter.balance + 1000, merchantAfter.hash), /already been decided/, "and only once");
  console.log("[PASS] once the customer has the order, the store collects its payment, on its own, exactly once");
});
