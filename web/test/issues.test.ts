import assert from "node:assert/strict";
import { test } from "node:test";
import { claimedValue } from "../src/lib/issues.ts";
import { decodeHandoverCode, encodeHandoverCode, matchesCommitment } from "../src/lib/handoverCode.ts";

// The same cases as dispatch_types::issues::tests -- keep them in step.
const lines = [
  { itemHex: "aa", unitPrice: 500, quantity: 2 },
  { itemHex: "bb", unitPrice: 1000, quantity: 1 },
];

test("a claim is worth its share of what was paid", () => {
  assert.equal(claimedValue(lines, 2000, [{ itemHex: "aa", quantity: 1 }]), 500);
  assert.equal(claimedValue(lines, 1600, [{ itemHex: "aa", quantity: 1 }]), 400);
  assert.equal(claimedValue(lines, 1600, [{ itemHex: "bb", quantity: 1 }, { itemHex: "aa", quantity: 2 }]), 1600);
});

test("a claim counts only what was ordered", () => {
  const two = [{ itemHex: "aa", unitPrice: 500, quantity: 2 }];
  assert.equal(claimedValue(two, 1000, [{ itemHex: "aa", quantity: 5 }]), 1000);
  assert.equal(claimedValue(two, 1000, [{ itemHex: "aa", quantity: 2 }, { itemHex: "aa", quantity: 2 }]), 1000);
  assert.equal(claimedValue(two, 1000, [{ itemHex: "zz", quantity: 1 }]), 0);
});

test("it rounds down", () => {
  const three = [{ itemHex: "aa", unitPrice: 333, quantity: 3 }];
  assert.equal(claimedValue(three, 999, [{ itemHex: "aa", quantity: 1 }]), 333);
  assert.equal(claimedValue(three, 998, [{ itemHex: "aa", quantity: 1 }]), 332);
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
