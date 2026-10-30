import assert from "node:assert/strict";
import { test } from "node:test";
import { invitationFingerprint, isInvitation, sealedAccount } from "../src/lib/account/deviceMove.ts";

// Made by the runtime (runtime/device/src/code.rs, `the_app_reads_the_same_codes`):
// the app must read exactly what it writes.
const SEALED = "relay-key:1:hCAkCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQldqCMwAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQECAgICAgICAgICAgICAgICAgICAgICAgIFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU";
const INVITATION = "relay-move:1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

test("a sealed key names its account", () => {
  const account = sealedAccount(SEALED);
  assert.ok(account);
  assert.deepEqual([...account.slice(0, 3)], [0x84, 0x20, 0x24], "an agent key");
  assert.deepEqual([...account.slice(3, 35)], new Array(32).fill(9), "the account's");
  assert.equal(sealedAccount(`  ${SEALED}\n`)?.length, 39, "whitespace aside");
});

test("an invitation is told apart from everything else", () => {
  assert.ok(isInvitation(INVITATION));
  for (const code of ["", INVITATION.slice(0, 20), SEALED, "relay-move:2:" + INVITATION.slice(13), "relay-account:uhCAkAAAA", INVITATION + "!"]) {
    assert.equal(isInvitation(code), false, code);
  }
  for (const code of ["", INVITATION, SEALED.slice(0, 60), "relay-key:1:AAAA"]) assert.equal(sealedAccount(code), null, code);
});

test("an invitation's fingerprint is 48 bits of its key, in three groups", () => {
  assert.equal(invitationFingerprint(INVITATION), "1A1B 1C1D 1E1F");
});
