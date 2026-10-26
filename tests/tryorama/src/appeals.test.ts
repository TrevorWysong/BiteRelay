// Proves appeals of a store's decision: a customer appeals their store's
// settlement to one of the network's arbiters, once, for no more than the
// store kept; the store answers; only that arbiter rules, once -- and the
// ruling is what the network's issuer pays from the store's cash-outs.
// Each side's evidence reaches only the arbiter.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators, retryingCaller } from "./helpers.js";

interface Evidence {
  note: string;
}
interface AppealView {
  appeal: Uint8Array;
  amount: number;
  refund: number;
  answered: boolean;
  customer_evidence: Evidence | null;
  store_evidence: Evidence | null;
  ruling: { award: number; reasons: string } | null;
}

await runScenario(async (scenario) => {
  const [customer, merchant, arbiter] = await setupPlayersWithProperties(scenario, 3, (keys) => ({ arbiters: [keys[2]], report_window_secs: 15 }));
  const all = [customer, merchant, arbiter];
  await useTestCoordinators(merchant, ["dispatch"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);

  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 2000, available: true }));
  await sync();
  const order = actionHash(await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_pickup_order", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 2000 })));
  await sync();
  await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: order }));
  await call(merchant, "dispatch")("mark_ready_for_pickup", order);
  await sync();
  await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", order), 40);
  await sync();
  const issue = actionHash(await call(customer, "dispatch")<HcRecord>("report_issue", { order, lines: [{ line: 0, quantity: 1, kind: "Wrong" }], note: "This is soup", photo_data_uri: "" }));
  await sync();
  await call(merchant, "dispatch")("respond_to_issue", { issue, accept: false });
  // Too soon: nothing to appeal until the store settles.
  await assert.rejects(call(customer, "dispatch")("file_appeal", { order, amount: 1000, note: "" }), /hasn't settled/);
  await retryUntil(
    async () => {
      await call(merchant, "dispatch")("settle_order", order).catch(() => 0);
      await sync();
      return call(customer, "dispatch")<{ refund: number | null }>("get_order_decisions", order).then((d) => d.refund);
    },
    (refund) => refund === 0,
    90,
    1000,
  );

  // ===== The customer appeals, once, for no more than the store kept =====
  await assert.rejects(call(merchant, "dispatch")("file_appeal", { order, amount: 1000, note: "" }), /customer appeals/);
  await assert.rejects(call(customer, "dispatch")("file_appeal", { order, amount: 2001, note: "" }), /up to what the store kept/);
  const appeal = await call(customer, "dispatch")<Uint8Array>("file_appeal", { order, amount: 2000, note: "Soup, not stew", photo_data_uri: "" });
  await assert.rejects(call(customer, "dispatch")("file_appeal", { order, amount: 500, note: "" }), /already appealed/);
  console.log("[PASS] a customer appeals their store's settlement once, for no more than it kept");

  // ===== The store answers; only the arbiter sees both sides =====
  await sync();
  const [against] = await retryUntil(() => call(merchant, "dispatch")<{ appeals: AppealView[] }>("get_appeals_against_me", { before: null }).then((p) => p.appeals), (a) => a.length === 1);
  assert.deepEqual([against.answered, against.customer_evidence], [false, null], "the store finds it to answer, without the customer's evidence");
  await call(merchant, "dispatch")("answer_appeal", { appeal, note: "It was stew", photo_data_uri: "" });
  await sync();
  const [docket] = await retryUntil(() => call(arbiter, "dispatch")<{ appeals: AppealView[] }>("get_my_docket", { before: null }).then((p) => p.appeals), (d) => d.length === 1 && d[0].answered);
  assert.deepEqual([docket.customer_evidence?.note, docket.store_evidence?.note, docket.amount, docket.refund], ["Soup, not stew", "It was stew", 2000, 0]);
  const asCustomer = await call(customer, "dispatch")<AppealView>("get_appeal_for_order", order);
  assert.deepEqual([asCustomer.customer_evidence?.note, asCustomer.store_evidence], ["Soup, not stew", null], "the customer sees their side, not the store's");
  console.log("[PASS] the store answers, and only the arbiter sees both sides");

  // ===== Only the arbiter rules, once =====
  await assert.rejects(call(merchant, "dispatch")("rule_on_appeal", { appeal, award: 0, reasons: "" }), /arbiter rules/);
  await assert.rejects(call(merchant, "dispatch")("create_raw_ruling_for_testing", { appeal, award: 0, reasons: "" }), /only an appeal's arbiter/, "nor can a modified app");
  await call(arbiter, "dispatch")("rule_on_appeal", { appeal, award: 1500, reasons: "A wrong dish, eaten in part." });
  await assert.rejects(call(arbiter, "dispatch")("rule_on_appeal", { appeal, award: 2000, reasons: "" }), /already ruled/);
  await sync();
  const ruled = await retryUntil(() => call(customer, "dispatch")<AppealView>("get_appeal_for_order", order), (v) => v.ruling !== null);
  assert.deepEqual([ruled.ruling!.award, ruled.ruling!.reasons], [1500, "A wrong dish, eaten in part."]);
  const due = await call(arbiter, "dispatch")<{ award: number; customer: Uint8Array }[]>("get_rulings_against", merchant.agentPubKey);
  assert.equal(due.length, 1);
  assert.ok(due[0].award === 1500 && Buffer.from(due[0].customer).equals(Buffer.from(customer.agentPubKey)), "what the issuer takes from the store's cash-outs, for the customer");
  console.log("[PASS] only the arbiter rules, once, and the award is due from the store");
});
