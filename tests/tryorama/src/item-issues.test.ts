// Proves the handover scan and the issue window hold against every party:
//
// - a scanned handover code is the customer's receipt: the driver completes
//   the delivery and is paid on the spot, and no arbitrator can then rule
//   it never arrived;
// - the store's food payment waits out the issue window, and moves only
//   when the window's arbitrator closes it -- never on the receipt alone;
// - only the customer reports, only items on the order, never more than
//   were ordered; only the store answers, once each; only the closing
//   arbitrator opens and closes the window, once, no sooner than the
//   window, for no more than the reports are worth;
// - the store has the final say: what it accepts or ignores is refunded at
//   the close, what it declines isn't.
import assert from "node:assert/strict";
import { dhtSync, getZomeCaller, runScenario } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { acceptOrder, actionHash, closeIssueWindow, handOff, latestLedgerEntry, retryUntil, retryUntilOk, setupPlayersWithProperties, ST_PETE, useTestCoordinators } from "./helpers.js";

/// Long enough to try closing early, short enough to wait out.
const WINDOW_SECS = 20;

interface PinSecret {
  pin: string;
  salt: Uint8Array;
}
interface IssueView {
  issue: Uint8Array;
  value: number;
  accepted: boolean | null;
  evidence: { note: string; photo_data_uri: string } | null;
}
interface IssueWindowView {
  opened_at: number | null;
  closed: number | null;
  opened_record: Uint8Array | null;
}

await runScenario(async (scenario) => {
  const [customer, merchant, driver, arbitrator] = await setupPlayersWithProperties(scenario, 4, (keys) => ({ arbitrators: [keys[3]], issue_window_secs: WINDOW_SECS }));
  const all = [customer, merchant, driver, arbitrator];
  for (const p of all) await useTestCoordinators(p, ["dispatch", "ledger"]);
  const sync = () => dhtSync(all, customer.cells[0].cell_id[0]);
  const call = (p: typeof customer, zome: string) => getZomeCaller(p.cells[0], zome);
  const balance = (p: typeof customer) => call(p, "ledger")<number>("get_balance", p.agentPubKey);
  /// `p` settling what it can on `order`, until its balance is `expected`.
  const settlesTo = (p: typeof customer, order: Uint8Array, expected: number) =>
    retryUntil(
      async () => {
        await call(p, "dispatch")("settle_order", order).catch(() => 0);
        return balance(p);
      },
      (b) => b === expected,
      60,
      1000,
    );
  const window = (order: Uint8Array) => call(customer, "dispatch")<IssueWindowView>("get_issue_window", order);

  const now = Date.now() * 1000;
  await call(customer, "profiles")("create_profile", { display_name: "", roles: ["Requester"], created_at: now });
  await call(merchant, "profiles")("create_profile", { display_name: "Mo", roles: ["Merchant"], created_at: now });
  await call(driver, "profiles")("create_profile", { display_name: "Dana", roles: ["Provider"], created_at: now });
  const store = actionHash(await call(merchant, "catalog")<HcRecord>("publish_catalog", { business_name: "Mo's", location: ST_PETE }));
  const stew = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Stew", price_cents: 1000, available: true }));
  const bread = actionHash(await call(merchant, "catalog")<HcRecord>("add_menu_item", { catalog_ref: store, name: "Bread", price_cents: 500, available: true }));
  await sync();

  // ===== A scanned handover =====
  const delivery = actionHash(
    await retryUntilOk(() => call(customer, "dispatch")<HcRecord>("request_delivery", { merchant: merchant.agentPubKey, catalog_ref: store, items: [{ item_ref: stew, quantity: 1 }], order_total: 1000, dropoff: ST_PETE, max_delivery_fee: null })),
  );
  await sync();
  await acceptOrder(merchant, delivery, all);
  const bid = actionHash(await retryUntilOk(() => call(driver, "dispatch")<HcRecord>("submit_bid", { order_ref: delivery, eta_seconds: 600, price_offer: 400 })));
  await sync();
  await retryUntilOk(() => call(customer, "dispatch")("accept_bid", { order_original_action: delivery, bid_action: bid }));
  await sync();
  await retryUntilOk(() => call(merchant, "dispatch")("set_order_status", { order_original_action: delivery, next_status: "MerchantConfirmed" }));
  await sync();
  await call(driver, "dispatch")("set_order_status", { order_original_action: delivery, next_status: "DriverEnRouteToMerchant" });
  await handOff(driver, merchant, delivery, "MerchantHandoff", all);
  await call(driver, "dispatch")("pick_up_order", delivery);
  await sync();
  const merchantBefore = await balance(merchant);

  const code = await call(customer, "dispatch")<PinSecret | null>("get_my_handover_code", delivery);
  assert.ok(code && /^\d{6}$/.test(code.pin) && code.salt.length === 16, "the customer's app has their handover code");
  assert.equal(await call(driver, "dispatch")("get_my_handover_code", delivery), null, "nobody else can read it");
  const dropOff = (scanned: PinSecret) => call(driver, "attestation")("record_leg", { order_ref: delivery, sequence: 1, kind: "CustomerHandoff", to: customer.agentPubKey, geo_at_completion: ST_PETE, scanned });
  await assert.rejects(dropOff({ pin: code.pin === "000000" ? "111111" : "000000", salt: code.salt }), /isn't for this order/, "a guessed code is refused");
  await dropOff(code);
  const completed = actionHash(await retryUntilOk(() => call(driver, "dispatch")<HcRecord>("complete_delivery", { order_original_action: delivery })));
  await sync();
  console.log("[PASS] a scanned handover code lets the driver complete the delivery themselves");

  await settlesTo(driver, delivery, 400);
  console.log("[PASS] the driver is paid on the scan, at once");

  // The store's food waits for the window, even with the customer's receipt.
  await call(merchant, "dispatch")("settle_order", delivery);
  assert.equal(await balance(merchant), merchantBefore, "the food isn't the store's yet");
  const [foodHold] = (await call(merchant, "ledger")<{ hold: Uint8Array; shares: { portion: string }[] }[]>("holds_for_order", delivery)).filter((h) => h.shares.some((s) => s.portion === "Food"));
  const merchantLatest = await latestLedgerEntry(merchant);
  await assert.rejects(
    call(merchant, "ledger")("create_raw_ledger_entry_for_testing", { kind: { Collect: { hold: foodHold.hold, portion: "Food", basis: completed } }, amount: 1000, balance: merchantLatest.balance + 1000, previous: merchantLatest.hash }),
    /grounds/,
    "a store can't take the food on the receipt and skip the window",
  );
  console.log("[PASS] the store's food payment can't move on the receipt alone");

  await closeIssueWindow(arbitrator, merchant, delivery, all);
  assert.equal((await window(delivery)).closed, 0, "closed with nothing reported");
  await settlesTo(merchant, delivery, merchantBefore + 1000);
  console.log("[PASS] once the window closes with nothing reported, the store collects the food");

  // A customer who let the driver scan can't then say it never came.
  await assert.rejects(
    call(customer, "dispatch")("raise_dispute", { order_original_action: delivery, reason: "NeverDelivered", description: "", evidence_refs: [] }),
    /can't be disputed/,
    "a delivery completed on a scan is settled",
  );
  console.log("[PASS] a delivery completed on a scan can't be disputed");

  // ===== Missing and wrong items =====
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
    await retryUntilOk(() => call(customer, "dispatch")("complete_pickup", ref), 40);
    await sync();
    return ref;
  };
  const raw = (p: typeof customer, fn: string, input: unknown) => call(p, "dispatch")(`create_raw_${fn}_for_testing`, input);

  const order = await pickup();
  const customerBefore = await balance(customer);
  const storeBefore = await balance(merchant);

  // Who can report what.
  await assert.rejects(raw(driver, "item_issue", { order, lines: [{ item_ref: bread, quantity: 1, kind: "Missing" }] }), /only the order's customer/, "a stranger can't report");
  await assert.rejects(raw(customer, "item_issue", { order, lines: [{ item_ref: bread, quantity: 3, kind: "Missing" }] }), /number ordered/, "nor more than was ordered");
  await assert.rejects(raw(customer, "item_issue", { order, lines: [{ item_ref: store, quantity: 1, kind: "Missing" }] }), /only items on the order/, "nor an item that wasn't on it");
  await assert.rejects(
    raw(customer, "item_issue", { order, lines: [{ item_ref: bread, quantity: 1, kind: "Missing" }, { item_ref: bread, quantity: 1, kind: "Wrong" }] }),
    /once in an issue/,
    "nor the same item twice in one report",
  );
  console.log("[PASS] only the customer reports, only items on the order, never more than ordered");

  const missingBread = actionHash(await call(customer, "dispatch")<HcRecord>("report_issue", { order, lines: [{ item_ref: bread, quantity: 1, kind: "Missing" }], note: "Only one bread in the bag", photo_data_uri: "" }));
  const wrongStew = actionHash(await call(customer, "dispatch")<HcRecord>("report_issue", { order, lines: [{ item_ref: stew, quantity: 1, kind: "Wrong" }], note: "This is soup", photo_data_uri: "" }));
  await sync();
  const seenByStore = await retryUntil(() => call(merchant, "dispatch")<IssueView[]>("get_issues_for_order", order), (issues) => issues.length === 2);
  assert.deepEqual(seenByStore.map((i) => i.value), [500, 1000], "each report is worth its share of what was paid");
  assert.equal(seenByStore[0].evidence?.note, "Only one bread in the bag", "the store reads the customer's note");
  assert.equal((await call(driver, "dispatch")<IssueView[]>("get_issues_for_order", order))[0].evidence, null, "nobody else does");
  console.log("[PASS] reports reach the store with their notes, sealed from everyone else");

  // Who can answer.
  await assert.rejects(raw(driver, "issue_response", { issue: missingBread, accept: false }), /only the order's store/, "a stranger can't answer");
  await call(merchant, "dispatch")("respond_to_issue", { issue: missingBread, accept: true });
  await call(merchant, "dispatch")("respond_to_issue", { issue: wrongStew, accept: false });
  await assert.rejects(raw(merchant, "issue_response", { issue: missingBread, accept: false }), /once/, "nor change its answer");
  await sync();
  console.log("[PASS] only the store answers, once each");

  // Who keeps the window.
  await assert.rejects(raw(merchant, "window_opened", { order, confirmation: order }), /closing arbitrator/, "the store can't open the window");
  await call(customer, "dispatch")("queue_issue_window", order);
  await sync();
  const opened = await retryUntil(
    async () => {
      await call(arbitrator, "dispatch")("keep_issue_window", order);
      return window(order);
    },
    (w) => w.opened_record !== null,
    40,
    1000,
  );
  await assert.rejects(raw(arbitrator, "window_closed", { opened: opened.opened_record, issues: [missingBread], refund: 500 }), /no sooner than the window/, "nor can it be closed early");
  await assert.rejects(raw(arbitrator, "window_opened", { order, confirmation: order }), /once|confirmation/, "nor opened twice");
  console.log("[PASS] only the closing arbitrator opens the window, once, and not even it can close it early");

  // The window runs out: the store's answers decide, and the arbitrator
  // only applies them -- within what the reports are worth.
  await new Promise((r) => setTimeout(r, WINDOW_SECS * 1000));
  await assert.rejects(raw(arbitrator, "window_closed", { opened: opened.opened_record, issues: [missingBread], refund: 501 }), /can't exceed/, "no refund beyond what's cited");
  await assert.rejects(raw(arbitrator, "window_closed", { opened: opened.opened_record, issues: [missingBread, missingBread], refund: 500 }), /each issue once/, "nor counting a report twice");
  assert.equal(await call(arbitrator, "dispatch")("keep_issue_window", order), true, "the window closes on its own");
  await sync();
  assert.equal((await window(order)).closed, 500, "the accepted report is refunded; the declined one isn't");
  await assert.rejects(raw(arbitrator, "window_closed", { opened: opened.opened_record, issues: [], refund: 0 }), /closes once/, "and it closes once");
  console.log("[PASS] the store has the final say: what it accepts is refunded, what it declines isn't");

  await settlesTo(customer, order, customerBefore + 500);
  await settlesTo(merchant, order, storeBefore + 1500);
  console.log("[PASS] at the close the customer collects the refund, the store the rest");

  // ===== A report the store ignores =====
  const ignored = await pickup();
  const customerThen = await balance(customer);
  await call(customer, "dispatch")("report_issue", { order: ignored, lines: [{ item_ref: bread, quantity: 2, kind: "Missing" }], note: "", photo_data_uri: "" });
  await sync();
  await closeIssueWindow(arbitrator, customer, ignored, all);
  assert.equal((await window(ignored)).closed, 1000, "a report the store never answers is refunded at the close");
  await settlesTo(customer, ignored, customerThen + 1000);
  console.log("[PASS] a report the store ignores is refunded when the window closes");
});
