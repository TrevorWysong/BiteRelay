// Every language's policies say the same rules: the same sections, each
// with as many points and effects, and as many risks -- under any network's
// settings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { POLICIES } from "../src/lib/policies";
import type { NetworkTerms } from "../src/holochain/types";

const base = {
  currency: "USD", credit_limit_cents: 0, min_redemption_cents: 1000, report_window_secs: 3600, answer_grace_secs: 600, claim_grace_secs: 1800, max_code_attempts: 5,
  max_concurrent_deliveries: 2, add_on_detour_km: 1.5, bid_window_secs: 60, minute_value_cents: 10, offer_secs: 60, pickup_grace_secs: 600, replacement_window_secs: 900,
  min_store_wait_secs: 300, max_store_wait_secs: 1800, store_wait_secs: 600, collection_window_secs: 3600, max_driver_changes: 3, max_pending_orders: 1, store_response_secs: 300,
  store_listing_stake: 0, min_reporter_stores: 3, reputation_window_days: 365, appeals: false, appeal_window_secs: 1_209_600, drivers_verified: false, verification_days: 365, restricted_min_age: null,
} as unknown as NetworkTerms;

const shape = (sections: ReturnType<(typeof POLICIES)["en"]["sections"]>) => sections.map((s) => [s.id, s.points.length, s.effects?.map((e) => e.who) ?? []]);

for (const terms of [base, { ...base, appeals: true, drivers_verified: true, restricted_min_age: 21, credit_limit_cents: 500, max_pending_orders: 3 } as NetworkTerms]) {
  test(`every language's policies match English${terms.appeals ? ", with appeals, verification and age limits" : ""}`, () => {
    const english = POLICIES.en;
    for (const [locale, content] of Object.entries(POLICIES)) {
      assert.deepEqual(shape(content.sections(terms)), shape(english.sections(terms)), locale);
      assert.equal(content.risks(terms).length, english.risks(terms).length, locale);
      assert.deepEqual(content.changes.map((c) => c.version), english.changes.map((c) => c.version), locale);
    }
  });
}
