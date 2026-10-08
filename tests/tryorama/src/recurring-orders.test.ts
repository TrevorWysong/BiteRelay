// Proves recurring order templates: create/list round-trip, invalid
// recurrence values rejected, toggling active and advancing next_run_at
// both collapse correctly back to exactly one Record per template (the
// real risk named in recurring.rs's own doc comment -- a naive local
// query() would otherwise return one Record per *action*, including every
// update, not one per logical template).
import assert from "node:assert/strict";
import { runScenario, dhtSync, getZomeCaller } from "@holochain-open-dev/tryorama";
import type { Record as HcRecord } from "@holochain/client";
import { appSource, actionHash, decodeEntry, ST_PETE } from "./helpers.js";

await runScenario(async (scenario) => {
  const [customer, merchant] = await scenario.addPlayersWithApps([{ appBundleSource: appSource }, { appBundleSource: appSource }]);
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
    next_run_at: now + 7 * 24 * 60 * 60 * 1_000_000,
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
  assert.deepEqual(decodeEntry<{ recurrence: unknown }>(templateRecord).recurrence, { Weekly: { weekday: 1, hour: 9, minute: 0 } });
  console.log("[PASS] a valid Weekly recurring template is created and round-trips");

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

  const nextRun = now + 14 * 24 * 60 * 60 * 1_000_000;
  await dispatchOf(customer)("advance_recurring_template", { original_action: templateRef, next_run_at: nextRun });
  templates = await dispatchOf(customer)<{ original_action: Uint8Array; record: HcRecord }[]>("list_my_recurring_templates", null);
  assert.equal(templates.length, 1, "advancing next_run_at must still not duplicate the template");
  assert.equal(decodeEntry<{ next_run_at: number }>(templates[0].record).next_run_at, nextRun, "next_run_at should reflect the advanced value");
  console.log("[PASS] advance_recurring_template advances in place, no duplicate Record");

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
