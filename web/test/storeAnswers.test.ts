import { test } from "node:test";
import assert from "node:assert/strict";
import { cancellationText, DECLINE_REASONS, responseDeadlineMs } from "../src/lib/storeAnswers.ts";

test("the response deadline is the window after the order reached the store", () => {
  // 1,000,000,000 µs = 1,000,000 ms; plus a 300 s window.
  assert.equal(responseDeadlineMs(1_000_000_000, 300), 1_000_000 + 300_000);
});

test("every cancellation reason reads as a sentence for the customer", () => {
  for (const reason of ["ByCustomer", "StoreDidNotRespond"] as const) {
    assert.match(cancellationText(reason), /\.$/);
  }
  for (const { reason } of DECLINE_REASONS) {
    assert.match(cancellationText({ ByStore: reason }), /^The store/);
  }
  assert.equal(cancellationText(null), "This order was cancelled.");
});
