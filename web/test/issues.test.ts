import assert from "node:assert/strict";
import { test } from "node:test";
import { claimedValue } from "../src/lib/orders/issues.ts";
import { decodeHandoverCode, encodeHandoverCode, matchesCommitment } from "../src/lib/orders/handoverCode.ts";

// The same cases as dispatch_types::issues::tests -- keep them in step.
const lines = [
  { unitPrice: 500, quantity: 2 },
  { unitPrice: 1000, quantity: 1 },
];

test("a claim is worth its share of what was paid", () => {
  assert.equal(claimedValue(lines, 2000, [{ line: 0, quantity: 1 }]), 500);
  assert.equal(claimedValue(lines, 1600, [{ line: 0, quantity: 1 }]), 400);
  assert.equal(claimedValue(lines, 1600, [{ line: 1, quantity: 1 }, { line: 0, quantity: 2 }]), 1600);
});

test("a claim counts only what was ordered", () => {
  const two = [{ unitPrice: 500, quantity: 2 }];
  assert.equal(claimedValue(two, 1000, [{ line: 0, quantity: 5 }]), 1000);
  assert.equal(claimedValue(two, 1000, [{ line: 0, quantity: 2 }, { line: 0, quantity: 2 }]), 1000);
  assert.equal(claimedValue(two, 1000, [{ line: 9, quantity: 1 }]), 0);
});

test("the same item on two lines is two prices", () => {
  assert.equal(claimedValue([{ unitPrice: 400, quantity: 1 }, { unitPrice: 460, quantity: 1 }], 860, [{ line: 1, quantity: 1 }]), 460);
});

test("it rounds down", () => {
  const three = [{ unitPrice: 333, quantity: 3 }];
  assert.equal(claimedValue(three, 999, [{ line: 0, quantity: 1 }]), 333);
  assert.equal(claimedValue(three, 998, [{ line: 0, quantity: 1 }]), 332);
});

test("a handover code round-trips, and checks against its commitment", async () => {
  const secret = { pin: "042917", salt: new Uint8Array(16).map((_, i) => i * 7) };
  const code = encodeHandoverCode("0abc", secret);
  const decoded = decodeHandoverCode(code);
  assert.ok(decoded);
  assert.equal(decoded.orderHex, "0abc");
  assert.equal(decoded.secret.pin, "042917");
  const input = new Uint8Array([...new TextEncoder().encode(secret.pin), ...secret.salt]);
  const commitment = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  assert.equal(await matchesCommitment(decoded.secret, commitment), true);
  assert.equal(await matchesCommitment({ ...decoded.secret, pin: "000000" }, commitment), false);
  assert.equal(decodeHandoverCode("https://example.com"), null, "anything else isn't a code");
});
