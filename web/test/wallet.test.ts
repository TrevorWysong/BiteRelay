import assert from "node:assert/strict";
import { test } from "node:test";
import { payoutAfterFees } from "../src/lib/wallet.ts";

// The same cases as ledger_types::tests -- keep them in step.
const profile = (flat: number, bps: number) => ({ payout_fee_cents: flat, payout_fee_basis_points: bps });

test("a payout is the amount less its fees", () => {
  assert.equal(payoutAfterFees(profile(25, 25), 10_000), 10_000 - 25 - 25);
  assert.equal(payoutAfterFees(profile(0, 0), 1234), 1234);
  assert.equal(payoutAfterFees(profile(0, 150), 333), 333 - 4);
  assert.equal(payoutAfterFees(profile(500, 0), 300), 0);
});
