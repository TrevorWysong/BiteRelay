import assert from "node:assert/strict";
import { test } from "node:test";
import { devSealedKey, readDevSealedKey } from "../src/holochain/devSealedKey";
import { bytesToBase64, base64ToBytes } from "../src/lib/util/base64";
import { sealedAccount } from "../src/lib/account/deviceMove";

/// An agent key's 39 bytes: Holochain's prefix, 32 of key, 4 of location.
const agent = new Uint8Array([0x84, 0x20, 0x24, ...new Array(32).fill(7), 1, 2, 3, 4]);
const where = { adminUrl: "ws://localhost:8888", installedAppId: "relay-abc" };

test("the dev host's code reads back as the account, wherever it lives", () => {
  // As the browser keeps the key: plain base64 (devIdentityStorage).
  const code = devSealedKey(base64ToBytes(bytesToBase64(agent)), where);
  assert.deepEqual([...sealedAccount(code)!], [...agent], "every reader takes it for the account");
  const read = readDevSealedKey(code);
  assert.deepEqual([...read!.account], [...agent]);
  assert.deepEqual(read!.where, where);
});

test("anything else isn't one", () => {
  assert.equal(readDevSealedKey("relay-key:1:AAAA"), null);
  assert.equal(readDevSealedKey(devSealedKey(agent, where).slice(0, 80)), null);
});
