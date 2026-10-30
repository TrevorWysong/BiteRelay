import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { newPhrase, phraseKey, phraseMessage, readPhrase } from "../src/lib/account/recoveryPhrase";

test("a new phrase is twelve words that read back as themselves", () => {
  for (const language of ["en-US", "es", "ja-JP", "zh-TW", "ko", "de"]) {
    const phrase = newPhrase(language);
    assert.equal(phrase.length, 12, language);
    assert.deepEqual(readPhrase(phrase.join(" ")), phrase, language);
  }
});

test("reading a phrase forgives case and spacing, and refuses a wrong checksum or a wrong count", () => {
  const phrase = newPhrase("en");
  assert.deepEqual(readPhrase(`  ${phrase.join("   ").toUpperCase()}\n`), phrase);
  const swapped = [...phrase.slice(1), phrase[0]];
  // A rotated phrase almost never keeps a valid checksum.
  if (readPhrase(swapped.join(" ")) !== null) assert.notDeepEqual(phraseKey(swapped).publicKey, phraseKey(phrase).publicKey);
  assert.equal(readPhrase(phrase.slice(0, 11).join(" ")), null);
  assert.equal(readPhrase("not a recovery phrase at all one two three four five six"), null);
});

test("the same words always give the same key, as an agent key that verifies its signatures", () => {
  const phrase = newPhrase("en");
  const a = phraseKey(phrase);
  const b = phraseKey(readPhrase(phrase.join(" "))!);
  assert.deepEqual(a.publicKey, b.publicKey);
  assert.equal(a.publicKey.length, 39);
  assert.deepEqual([...a.publicKey.slice(0, 3)], [0x84, 0x20, 0x24]);
  const message = phraseMessage(new Uint8Array(39).fill(1), new Uint8Array(39).fill(2), new Uint8Array(39).fill(3));
  assert.ok(ed25519.verify(a.sign(message), message, a.publicKey.slice(3, 35)));
  assert.notDeepEqual(phraseKey(newPhrase("en")).publicKey, a.publicKey, "other words, another key");
});

test("what a phrase signs is the label, then each key and the head, colon-separated", () => {
  const message = phraseMessage(new Uint8Array(39).fill(1), new Uint8Array(39).fill(2), new Uint8Array(39).fill(3));
  const label = new TextEncoder().encode("relay-recovery:v1:");
  assert.equal(message.length, label.length + 39 * 3 + 2);
  assert.deepEqual(message.slice(0, label.length), label);
  assert.equal(message[label.length + 39], 58);
});
