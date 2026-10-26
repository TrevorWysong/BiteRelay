// Proves the store has the final say on missing and wrong items, within
// rules that hold against every party:
//
// - only the customer reports, only items on the order, never more than
//   were ordered; only the store answers, once each;
// - the store's app settles the food once the customer's report window has
//   run: what it accepted or never answered is refunded, what it declined
//   isn't;
// - only the store settles, once, citing that the customer has the order,
//   for no more than the reports it cites are worth.
import assert from "node:assert/strict";
import { dhtSync, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { actionHash, FULL_SIZE_PHOTO, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators, retryingCaller } from "./helpers.js";

/// Long enough to report in, short enough to wait out.
// Long enough that a slow CI runner files both reports before it closes.
const REPORT_WINDOW_SECS = 60;

interface IssueView {
  issue: Uint8Array;
  value: number;
  accepted: boolean | null;
  evidence: { note: string; photo_data_uri: string } | null;
}

await runScenario(async (scenario) => {
  const [customer, merchant, stranger] = await setupPlayersWithProperties(scenario, 3, () => ({ report_window_secs: REPORT_WINDOW_SECS }));
  const all = [customer, merchant, stranger];
  for (const p of all) await useTestCoordinators(p, ["dispatch", "catalog", "reputation"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => retryingCaller(p.cells[0], zome);
  const balance = (p: typeof customer) => call(p, "ledger")<number>("get_balance", p.agentPubKey);
  const settlesTo = (p: typeof customer, order: Uint8Array, expected: number) =>
    retryUntil(
      async () => {
        await call(p, "dispatch")("settle_order", order).catch(() => 0);
        return balance(p);
      },
      (b) => b === expected,
      150,
      1000,
    );
  const refundOf = (order: Uint8Array) => call(customer, "dispatch")<{ refund: number | null }>("get_order_decisions", order).then((d) => d.refund);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 1000, available: true }));
  const bread = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Bread", price_cents: 500, available: true }));
  await sync();

  /// A pickup of a stew and two breads, collected: returns the order and
  /// the customer's update collecting it.
  const pickup = async () => {
    const ref = actionHash(
      await retryUntilOk(() =>
        call(customer, "dispatch")<HcRecord>("request_pickup_order", {
          merchant: merchant.agentPubKey,
          catalog_ref: store,
          items: [
            { item_ref: stew, quantity: 1 },
            { item_ref: bread, quantity: 2 },
          ],
          order_total: 2000,
        }),
      ),
    );
    await sync();
    await retryUntilOk(() => call(merchant, "dispatch")("accept_pickup_order", { order_original_action: ref }));
    await call(merchant, "dispatch")("mark_ready_for_pickup", ref);
    await sync();
    const collected = actionHash(await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("complete_pickup", ref), 40));
    await sync();
    return { ref, collected };
  };
  // The order's lines, by position: as the items were listed.
  const STEW = 0;
  const BREAD = 1;
  const raw = (p: typeof customer, fn: string, input: unknown) => call(p, "dispatch")(`create_raw_${fn}_for_testing`, input);

  const customerBefore = await balance(customer);
  const storeBefore = await balance(merchant);
  const { ref: order, collected } = await pickup();

  // Who can report what.
  await assert.rejects(raw(stranger, "item_issue", { order, lines: [{ line: BREAD, quantity: 1, kind: "Missing" }] }), /only the order's customer/, "a stranger can't report");
  await assert.rejects(raw(customer, "item_issue", { order, lines: [{ line: BREAD, quantity: 3, kind: "Missing" }] }), /number ordered/, "nor more than was ordered");
  await assert.rejects(raw(customer, "item_issue", { order, lines: [{ line: 5, quantity: 1, kind: "Missing" }] }), /only lines on the order/, "nor a line that wasn't on it");
  await assert.rejects(
    raw(customer, "item_issue", { order, lines: [{ line: BREAD, quantity: 1, kind: "Missing" }, { line: BREAD, quantity: 1, kind: "Wrong" }] }),
    /once in an issue/,
    "nor the same line twice in one report",
  );
  console.log("[PASS] only the customer reports, only items on the order, never more than ordered");

  const missingBread = actionHash(await call(customer, "dispatch")<HcRecord>("report_issue", { order, lines: [{ line: BREAD, quantity: 1, kind: "Missing" }], note: "Only one bread in the bag", photo_data_uri: FULL_SIZE_PHOTO }));
  await assert.rejects(raw(customer, "item_issue", { order, lines: [{ line: BREAD, quantity: 1, kind: "Wrong" }] }), /each line of an order is reported once/, "a line already reported can't be reported again");
  const wrongStew = actionHash(await call(customer, "dispatch")<HcRecord>("report_issue", { order, lines: [{ line: STEW, quantity: 1, kind: "Wrong" }], note: "This is soup", photo_data_uri: "" }));
  await sync();
  const seenByStore = await retryUntil(() => call(merchant, "dispatch")<IssueView[]>("get_issues_for_order", order), (issues) => issues.length === 2);
  assert.deepEqual(seenByStore.map((i) => i.value), [500, 1000], "each report is worth its share of what was paid");
  assert.equal(seenByStore[0].evidence?.note, "Only one bread in the bag", "the store reads the customer's note");
  assert.equal(seenByStore[0].evidence?.photo_data_uri, FULL_SIZE_PHOTO, "and their full-size photo");
  assert.equal((await call(stranger, "dispatch")<IssueView[]>("get_issues_for_order", order))[0].evidence, null, "nobody else does");
  console.log("[PASS] reports reach the store with their notes, sealed from everyone else");

  // Who can answer.
  await assert.rejects(raw(stranger, "issue_response", { issue: missingBread, accept: false }), /only the order's store/, "a stranger can't answer");
  await call(merchant, "dispatch")("respond_to_issue", { issue: missingBread, accept: true });
  await call(merchant, "dispatch")("respond_to_issue", { issue: wrongStew, accept: false });
  await assert.rejects(raw(merchant, "issue_response", { issue: missingBread, accept: false }), /once/, "nor change its answer");
  await sync();
  console.log("[PASS] only the store answers, once each");

  // Who can settle, and for how much.
  const settlement = (by: typeof customer, input: Record<string, unknown>) => raw(by, "settlement", { order, basis: collected, issues: [missingBread], refund: 500, ...input });
  await assert.rejects(settlement(stranger, {}), /only the order's store settles/, "a stranger can't settle it");
  await assert.rejects(settlement(merchant, { refund: 501 }), /can't exceed/, "nor the store refund more than the reports it cites are worth");
  await assert.rejects(settlement(merchant, { issues: [missingBread, missingBread] }), /each issue once/, "nor count a report twice");
  await assert.rejects(settlement(merchant, { basis: order }), /customer has the order/, "nor settle before the customer has it");
  console.log("[PASS] only the store settles, citing that the customer has the order, for no more than the reports are worth");

  // The window runs out: the store's app settles on its answers.
  await settlesTo(merchant, order, storeBefore + 1500);
  await settlesTo(customer, order, customerBefore - 2000 + 500);
  assert.equal(await refundOf(order), 500, "the accepted report is refunded; the declined one isn't");
  await assert.rejects(settlement(merchant, { refund: 0, issues: [] }), /settled once/, "and it's settled once");
  await assert.rejects(call(customer, "dispatch")("report_issue", { order, lines: [{ line: STEW, quantity: 1, kind: "Missing" }], note: "", photo_data_uri: "" }), /already settled/, "a report after that comes too late");
  console.log("[PASS] the store has the final say: what it accepts is refunded, what it declines isn't");

  // ===== Reviews, once each =====
  await call(customer, "reputation")("submit_review", { target: { Store: store }, order_original_action: order, rating: 5, comment: "" });
  await assert.rejects(call(customer, "reputation")("submit_review", { target: { Store: store }, order_original_action: order, rating: 1, comment: "" }), /already rated/);
  await assert.rejects(
    call(customer, "reputation")("create_raw_review_for_testing", { target: { Store: store }, author: customer.agentPubKey, order_ref: collected, rating: 1, comment: "", created_at: Date.now() * 1000 }),
    /each reviewed once/,
    "a customer reviews an order's store once, so nobody buries a store's reviews",
  );
  console.log("[PASS] an order's store is reviewed once");

  // ===== A report the store ignores =====
  const customerThen = await balance(customer);
  const { ref: ignored } = await pickup();
  await call(customer, "dispatch")("report_issue", { order: ignored, lines: [{ line: BREAD, quantity: 2, kind: "Missing" }], note: "", photo_data_uri: "" });
  await sync();
  await retryUntil(
    async () => {
      await call(merchant, "dispatch")("settle_order", ignored).catch(() => 0);
      return refundOf(ignored);
    },
    (refund) => refund !== null,
    150,
    1000,
  );
  assert.equal(await refundOf(ignored), 1000, "a report the store never answers is refunded");
  await settlesTo(customer, ignored, customerThen - 2000 + 1000);
  console.log("[PASS] a report the store ignores is refunded when its window closes");
});
