// A refund that waits on a lost key: what a part's recipient would give
// back to its payer, and can't -- a store whose phone was lost before it
// gave back the food of an order called off. An issuer grants the payer in
// the part's place (`IssuerGrant::in_place_of`), and the payer's own chain
// keeps the two apart: they take the grant instead of the part
// (`LedgerKind::Returned`), never both, whichever comes first
// (docs/RECOVERY.md). Forgeries are written raw (test-utils), as a modified
// client would.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { ActionHash, Record as HcRecord } from "@holochain/client";
import { EMPTY_HANDS, ST_PETE, actionHash, bytesEqual, decodeEntry, latestLedgerEntry, phraseKey, phraseMessage, retryUntil, retryUntilOk, retryingCaller, setupPlayersWithProperties, useTestCoordinators } from "./helpers.js";

interface Unreturned {
  order: ActionHash;
  hold: ActionHash;
  portion: string;
  amount: number;
  payer: Uint8Array;
}
interface HoldView {
  hold: ActionHash;
  shares: { portion: string; amount: number }[];
}

await runScenario(async (scenario) => {
  const [issuer, customer, merchant, successor] = await setupPlayersWithProperties(scenario, 4, (keys) => ({ issuers: [keys[0]], credit_limit_cents: 0, store_listing_stake: 0 }));
  const all = [issuer, customer, merchant, successor];
  for (const p of [customer, merchant]) await useTestCoordinators(p, ["ledger"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const balance = (p: typeof customer) => call(p, "ledger")<number>("get_balance", p.agentPubKey);
  const forge = async (p: typeof customer, kind: unknown, amount: number) => {
    const latest = await latestLedgerEntry(p);
    return call(p, "ledger")("create_raw_ledger_entry_for_testing", { kind, amount, balance: latest.balance + amount, in_hand: EMPTY_HANDS, previous: latest.hash });
  };
  const grant = (to: Uint8Array, amount: number, reference: string, in_place_of: unknown = null, by = issuer) => call(by, "ledger")<ActionHash>("issue_grant", { to, amount, reference, in_place_of });
  const collectGrants = () => call(customer, "ledger")<number>("collect_grants", null);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "Cara", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const soup = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Soup", price_cents: 600, available: true }));
  await grant(customer.agentPubKey, 5000, "payment-1");
  await sync();
  await retryUntilOk(() => collectGrants().then((n) => (n === 1 ? n : Promise.reject(new Error("not yet")))));

  // ===== The store's phone is lost; its owner recovers onto a new key =====
  const phrase = phraseKey();
  const plan = await call(merchant, "account")<{ plan: Uint8Array }>("set_recovery_plan", { phrase_key: phrase.key, guardians: [], threshold: 0 });
  await sync();
  const planHead = await retryUntil(() => call(successor, "account")<Uint8Array | null>("latest_action_of", merchant.agentPubKey), (h) => !!h);
  const succession = await call(successor, "account")<ActionHash>("take_over", { predecessor: merchant.agentPubKey, authority: { Phrase: { plan: plan.plan, head: planHead, signature: phrase.sign(phraseMessage(merchant.agentPubKey, successor.agentPubKey, planHead!)) } } });
  await sync();

  // Two orders the store never answers, which the customer calls off. Its
  // food was held when they ordered, and only the store gives it back. (The
  // store's own app, seeing its account moved, no longer settles.)
  const ordered = async () => {
    const order = actionHash(await call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: soup, quantity: 1 }], order_total: 600 }));
    await call(customer, "dispatch")("cancel_pickup_order", order);
    return order;
  };
  const first = await ordered();
  const second = await ordered();
  await sync();
  assert.equal(await balance(customer), 5000 - 1200, "both orders' food still held");
  const holdOf = async (order: ActionHash) => (await retryUntil(() => call(customer, "ledger")<HoldView[]>("holds_for_order", order), (h) => h.length === 1))[0].hold;
  const [firstHold, secondHold] = [await holdOf(first), await holdOf(second)];

  // ===== What the lost key would have given back, as the issuer reads it =====
  const head = await call(merchant, "account")<ActionHash | null>("latest_action_of", merchant.agentPubKey);
  assert.ok(head);
  const unreturned = await retryUntil(() => call(issuer, "dispatch")<Unreturned[]>("unreturned_by", { agent: merchant.agentPubKey, head, days: 7 }), (parts) => parts.length === 2, 60, 1000);
  for (const order of [first, second]) {
    const part = unreturned.find((p) => bytesEqual(p.order, order));
    assert.ok(part && part.portion === "Food" && part.amount === 600 && bytesEqual(part.payer, customer.agentPubKey), "each order's food, to the customer who paid it");
  }
  assert.deepEqual(await call(issuer, "dispatch")("uncollected_by", { agent: merchant.agentPubKey, head, days: 7 }), [], "and nothing the store was owed");
  console.log("[PASS] what a lost store would have given back is found, even on orders it never answered");

  // ===== The issuer's grant in its place: only for exactly that part =====
  const inPlace = (hold: ActionHash, portion = "Food", basis: ActionHash = succession) => ({ hold, portion, succession: basis });
  await assert.rejects(grant(customer.agentPubKey, 601, "r-more", inPlace(firstHold)), /exactly that part/, "never more than the part");
  await assert.rejects(grant(successor.agentPubKey, 600, "r-other", inPlace(firstHold)), /hold's payer/, "only to the hold's payer");
  await assert.rejects(grant(customer.agentPubKey, 600, "r-nobody", inPlace(firstHold, "Food", first)), /taking over its recipient's account/, "only once the recipient's account has been taken over");
  await assert.rejects(grant(customer.agentPubKey, 600, "r-fee", inPlace(firstHold, "Fee")), /no such part/);
  await assert.rejects(grant(customer.agentPubKey, 600, "r-self", inPlace(firstHold), customer), /only an issuer/, "and only from an issuer");
  console.log("[PASS] a grant in a part's place is only an issuer's, only to its payer, only for that part, only for a recovered recipient");

  // ===== First the grant: the part can't come from the hold too =====
  const firstGrant = await grant(customer.agentPubKey, 600, "recovery:first", inPlace(firstHold));
  await sync();
  await assert.rejects(forge(customer, { Deposit: { grant: firstGrant } }, 600), /collected as that part/, "never as a plain deposit");
  assert.equal(await retryUntilOk(() => collectGrants().then((n) => (n === 1 ? n : Promise.reject(new Error("not yet"))))), 1);
  assert.equal(await balance(customer), 5000 - 600, "the first order's food back, from the issuer");
  const latest = decodeEntry<{ kind: Record<string, unknown> }>((await call(customer, "ledger")<{ entries: HcRecord[] }>("list_my_ledger", { before: null })).entries[0]);
  assert.ok("Returned" in latest.kind, "collected as the part it's in place of");
  assert.equal(await collectGrants(), 0, "once");
  await assert.rejects(forge(customer, { Returned: { grant: firstGrant, hold: firstHold, portion: "Food" } }, 600), /already been decided/, "not twice");
  // The old phone turns up and gives the part back after all: the customer
  // can't collect it from the hold as well.
  const waiver = await call(merchant, "ledger")<ActionHash>("waive", { hold: firstHold, portion: "Food" });
  await sync();
  await assert.rejects(forge(customer, { Collect: { hold: firstHold, portion: "Food", basis: waiver } }, 600), /already been decided/, "the part is decided: the grant took its place");
  await call(customer, "dispatch")("settle_order", first);
  assert.equal(await balance(customer), 5000 - 600, "settling takes nothing more");
  console.log("[PASS] a payer who took the grant can't collect the part from the hold too, nor the grant twice");

  // ===== First the part: the grant can't be taken too =====
  await call(merchant, "ledger")("waive", { hold: secondHold, portion: "Food" });
  await sync();
  await retryUntil(() => call(customer, "dispatch")<number>("settle_order", second).then(() => balance(customer)), (b) => b === 5000, 30, 1000);
  const secondGrant = await grant(customer.agentPubKey, 600, "recovery:second", inPlace(secondHold));
  await sync();
  assert.equal(await collectGrants(), 0, "a part already collected isn't taken again in its place");
  await assert.rejects(forge(customer, { Returned: { grant: secondGrant, hold: secondHold, portion: "Food" } }, 600), /already been decided/);
  assert.equal(await balance(customer), 5000, "every cent back, and not one more");
  console.log("[PASS] a payer who collected the part from the hold can't take a grant in its place too");
});
