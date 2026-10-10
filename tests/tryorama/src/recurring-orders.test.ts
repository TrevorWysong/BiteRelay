// Proves recurring order templates: create/list round-trip, invalid
// recurrence values rejected, updates collapse back to exactly one Record
// per template (a naive local query() would return one per action), and
// the customer's own conductor fires a due template -- placing its order
// and moving it to its next occurrence -- with nothing calling it.
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, retryUntil, ST_PETE, testApp } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([testApp, testApp]);
  const all = [customer, merchant];
  await scenario.shareAllAgents();

  const profilesOf = (p: typeof customer) => getZomeCaller(p.cells[0], "profiles");
  const catalogOf = (p: typeof customer) => getZomeCaller(p.cells[0], "catalog");
  const dispatchOf = (p: typeof customer) => getZomeCaller(p.cells[0], "dispatch");

  const now = Date.now() * 1000;
  await profilesOf(customer)("create_profile", { display_name: "Cara Customer", roles: ["Requester"], created_at: now });
  await profilesOf(merchant)("create_profile", { display_name: "Mo Merchant", roles: ["Merchant"], created_at: now });

  const catalogRecord = await catalogOf(merchant)<HcRecord>("publish_catalog", { business_name: "Mo's Kitchen", location: ST_PETE });
  const catalogRef = actionHash(catalogRecord);
  const itemRecord = await catalogOf(merchant)<HcRecord>("add_menu_item", { catalog_ref: catalogRef, name: "Empanada", price_cents: 1000, available: true });
  const itemRef = actionHash(itemRecord);
  // The template references the store; a customer has always seen it first.
  await dhtSync([customer, merchant], customer.cells[0].cell_id[0]);

  const baseInput = {
    merchant: merchant.agentPubKey,
    catalog_ref: catalogRef,
    item_refs: [itemRef],
    dropoff: ST_PETE,
    max_delivery_fee: null,
    time_zone: "UTC",
  };

  // Invalid recurrence values rejected.
  await assert.rejects(
    dispatchOf(customer)("create_recurring_template", { ...baseInput, recurrence: { Weekly: { weekday: 7, hour: 9, minute: 0 } } }),
    /Weekly's weekday must be 0-6/,
    "a weekday of 7 must be rejected",
  );
  await assert.rejects(
    dispatchOf(customer)("create_recurring_template", { ...baseInput, recurrence: { Daily: { hour: 24, minute: 0 } } }),
    /Daily's hour must be 0-23/,
    "an hour of 24 must be rejected",
  );
  console.log("[PASS] out-of-range recurrence values are rejected");

  const templateRecord = await dispatchOf(customer)<HcRecord>("create_recurring_template", {
    ...baseInput,
    recurrence: { Weekly: { weekday: 1, hour: 9, minute: 0 } },
  });
  const templateRef = actionHash(templateRecord);
  const created = decodeEntry<{ recurrence: unknown; next_run_at: number }>(templateRecord);
  assert.deepEqual(created.recurrence, { Weekly: { weekday: 1, hour: 9, minute: 0 } });
  const firstRun = new Date(created.next_run_at / 1000);
  assert.ok(firstRun.getUTCDay() === 1 && firstRun.getUTCHours() === 9 && firstRun.getUTCMinutes() === 0 && created.next_run_at > now, "the conductor schedules the first run: the next Monday 9:00 in its zone");
  console.log("[PASS] a valid Weekly recurring template is created, with its first run worked out in its own time zone");

  let templates = await dispatchOf(customer)<{ original_action: Uint8Array; record: HcRecord }[]>("list_my_recurring_templates", null);
  assert.equal(templates.length, 1, "exactly one template should be listed after one creation");
  console.log("[PASS] list_my_recurring_templates returns the newly created template");

  // Toggle active off, then on -- list must still show exactly one Record,
  // not one per update action.
  await dispatchOf(customer)("set_recurring_template_active", { original_action: templateRef, active: false });
  templates = await dispatchOf(customer)<{ original_action: Uint8Array; record: HcRecord }[]>("list_my_recurring_templates", null);
  assert.equal(templates.length, 1, "toggling active must not duplicate the template in the list");
  assert.equal(decodeEntry<{ active: boolean }>(templates[0].record).active, false, "the toggled template should reflect active: false");
  console.log("[PASS] set_recurring_template_active updates in place, no duplicate Record");

  // --- A due template fires on the conductor, with no app involved. ---
  // Daily, a couple of minutes from now in UTC.
  const soon = new Date(Date.now() + 2 * 60_000);
  const standing = actionHash(
    await dispatchOf(customer)<HcRecord>("create_recurring_template", { ...baseInput, recurrence: { Daily: { hour: soon.getUTCHours(), minute: soon.getUTCMinutes() } } }),
  );
  const placed = await retryUntil(
    () => dispatchOf(customer)<{ record: HcRecord }[]>("get_my_active_orders", null).catch(() => []),
    (orders) => orders.length > 0,
    240,
    1000,
  );
  assert.equal(placed.length, 1, "the standing order fired once (the paused one didn't)");
  const order = decodeEntry<{ status: string; lines: { item_ref: Uint8Array; quantity: number }[]; order_total: number }>(placed[0].record);
  assert.equal(order.status, "Placed");
  assert.equal(order.order_total, 1000, "priced from the menu as it stands");
  templates = await dispatchOf(customer)<{ original_action: Uint8Array; record: HcRecord }[]>("list_my_recurring_templates", null);
  assert.equal(templates.length, 2, "firing updates the template in place");
  const fired = templates.find((t) => Buffer.from(t.original_action).equals(Buffer.from(standing)))!;
  const nextRun = decodeEntry<{ next_run_at: number }>(fired.record).next_run_at;
  assert.ok(nextRun > Date.now() * 1000 + 23 * 3_600_000_000, "and moves it to tomorrow's occurrence");
  console.log("[PASS] the customer's conductor fires a due standing order and moves it to its next occurrence");

  // A non-owner can't tamper with someone else's template. Needs a real
  // dhtSync first -- this entry deliberately has no DHT link (see its own
  // doc comment), so the merchant's conductor has no other way to have
  // even seen it yet; without this, resolve_latest would fail with
  // "record not found" before ever reaching the authorship check this
  // assertion actually means to exercise.
  await dhtSync(all, customer.cells[0].cell_id[0]);
  await assert.rejects(
    dispatchOf(merchant)("set_recurring_template_active", { original_action: templateRef, active: true }),
    /a recurring order template can only be updated by its own requester/,
    "a non-owner must not be able to toggle someone else's recurring template",
  );
  console.log("[PASS] a non-owner cannot modify another agent's recurring template");
});
